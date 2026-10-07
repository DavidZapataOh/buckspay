// Package mobile proves single messages of a note chain on the phone. The cgo exports live in
// mobile/lib; this package has no cgo so that its logic is tested with `go test`.
package mobile

import (
	"bufio"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sync"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend"
	"github.com/consensys/gnark/backend/groth16"
	cs_bn254 "github.com/consensys/gnark/constraint/bn254"
	"github.com/consensys/gnark/frontend"

	"github.com/DavidZapataOh/buckspay/prover/circuit"
	"github.com/DavidZapataOh/buckspay/prover/proofenc"
	"github.com/DavidZapataOh/buckspay/prover/witness"
)

const (
	// ProofLen is the compressed proof the Solana verifier reads; PublicLen the ten public inputs, 32 big-endian bytes each.
	ProofLen  = proofenc.CompressedLen
	PublicLen = circuit.NumPublic * 32

	maxMessages = 17
	bodyHeader  = 1 + 2
	signature   = 32 + 32 + 33
	openingLen  = 33 + 8 + 27 + 16 + 1
)

// ErrNoKey is returned by Prove while no key is loaded.
var ErrNoKey = errors.New("no proving key loaded")

var loaded struct {
	sync.Mutex
	ccs *cs_bn254.R1CS
	pk  groth16.ProvingKey
}

// guard turns a panic of the proving libraries on malformed input into an error: a panic must never cross cgo.
func guard(err *error) {
	if r := recover(); r != nil {
		*err = fmt.Errorf("prover: %v", r)
	}
}

// Load reads ccs.bin and pk.dump from dir and keeps them for Prove, replacing any key already loaded.
func Load(dir string) (err error) {
	defer guard(&err)
	Release()
	ccs, pk, err := readKeys(dir)
	if err != nil {
		return err
	}
	loaded.Lock()
	loaded.ccs, loaded.pk = ccs, pk
	loaded.Unlock()
	return nil
}

func readKeys(dir string) (*cs_bn254.R1CS, groth16.ProvingKey, error) {
	ccs := new(cs_bn254.R1CS)
	if err := readFrom(filepath.Join(dir, "ccs.bin"), ccs); err != nil {
		return nil, nil, err
	}
	pk := groth16.NewProvingKey(ecc.BN254)
	f, err := os.Open(filepath.Join(dir, "pk.dump"))
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	if err := pk.ReadDump(bufio.NewReaderSize(f, 1<<20)); err != nil {
		return nil, nil, err
	}
	return ccs, pk, nil
}

func readFrom(path string, r interface {
	ReadFrom(io.Reader) (int64, error)
}) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = r.ReadFrom(bufio.NewReaderSize(f, 1<<20))
	return err
}

// Release drops the keys and hands the memory back to the system.
func Release() {
	loaded.Lock()
	loaded.ccs, loaded.pk = nil, nil
	loaded.Unlock()
	runtime.GC()
	debug.FreeOSMemory()
}

// Expand turns the compressed proving key into the raw dump Load reads, atomically.
func Expand(pkBin, pkDump string) (err error) {
	defer guard(&err)
	pk := groth16.NewProvingKey(ecc.BN254)
	if err := readFrom(pkBin, pk); err != nil {
		return err
	}
	tmp := pkDump + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(f, 1<<20)
	if err := pk.WriteDump(w); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := w.Flush(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, pkDump)
}

// Prove proves message index of the chain in wire form (see DecodeChain) and returns the compressed
// proof followed by the public inputs.
func Prove(chain []byte, index int) (out []byte, err error) {
	defer guard(&err)
	c, err := DecodeChain(chain)
	if err != nil {
		return nil, err
	}
	if index < 0 || index >= len(c.Messages) {
		return nil, fmt.Errorf("message %d of a chain of %d", index, len(c.Messages))
	}
	loaded.Lock()
	defer loaded.Unlock()
	if loaded.pk == nil {
		return nil, ErrNoKey
	}
	a, err := witness.Assign(c, index)
	if err != nil {
		return nil, err
	}
	full, err := frontend.NewWitness(a, ecc.BN254.ScalarField())
	if err != nil {
		return nil, err
	}
	proof, err := groth16.Prove(loaded.ccs, loaded.pk, full, backend.WithProverHashToFieldFunction(sha256.New()))
	if err != nil {
		return nil, err
	}
	comp, err := proofenc.Compress(proof)
	if err != nil {
		return nil, err
	}
	pub, err := witness.PublicBytes(c, index)
	if err != nil {
		return nil, err
	}
	return append(comp, pub...), nil
}

// DecodeChain reads the form the app writes: domain (32), message count (1), each message as kind (1),
// body length (2, big-endian), body, r (32), s (32) and signer key (33); then one opening per message
// as owner (33), amount (8, big-endian), caveats (27), salt (16) and output index (1).
func DecodeChain(b []byte) (*witness.Chain, error) {
	if len(b) < 33 {
		return nil, errors.New("chain too short")
	}
	c := &witness.Chain{}
	copy(c.Domain[:], b)
	n := int(b[32])
	if n == 0 || n > maxMessages {
		return nil, fmt.Errorf("%d messages", n)
	}
	b = b[33:]
	for range n {
		if len(b) < bodyHeader {
			return nil, errors.New("truncated message")
		}
		size := int(binary.BigEndian.Uint16(b[1:3]))
		if size > circuit.MaxBody || len(b) < bodyHeader+size+signature {
			return nil, errors.New("truncated message")
		}
		m := witness.Signed{Kind: b[0], Body: append([]byte(nil), b[bodyHeader:bodyHeader+size]...)}
		s := b[bodyHeader+size:]
		m.R, m.S = new(big.Int).SetBytes(s[:32]), new(big.Int).SetBytes(s[32:64])
		copy(m.Key[:], s[64:signature])
		c.Messages = append(c.Messages, m)
		b = b[bodyHeader+size+signature:]
	}
	if len(b) != n*openingLen {
		return nil, errors.New("openings do not match the messages")
	}
	for range n {
		var o witness.Opening
		copy(o.Owner[:], b)
		o.Amount = binary.BigEndian.Uint64(b[33:41])
		copy(o.Caveats[:], b[41:68])
		copy(o.Salt[:], b[68:84])
		o.Index = b[84]
		if o.Index > 1 {
			return nil, errors.New("output index")
		}
		c.Openings = append(c.Openings, o)
		b = b[openingLen:]
	}
	return c, nil
}
