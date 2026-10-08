package mobile

import (
	"errors"
	"fmt"
	"io/fs"
	"math/big"
	"os"
	"runtime"
	"runtime/debug"
	"sync"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	groth16bn254 "github.com/consensys/gnark/backend/groth16/bn254"
	cs_bn254 "github.com/consensys/gnark/constraint/bn254"
	"github.com/consensys/gnark/frontend"

	"github.com/DavidZapataOh/buckspay/prover/netting"
	"github.com/DavidZapataOh/buckspay/prover/proofenc"
)

// NettingProofLen is the raw proof the Solana verifier reads: A 64, B 128, C 64, big-endian, A not negated.
const NettingProofLen = proofenc.PlainRawLen

var loadedNetting struct {
	sync.Mutex
	dir string
	ccs *cs_bn254.R1CS
	pk  groth16.ProvingKey
}

// ReleaseNetting drops the netting key and hands the memory back to the system.
func ReleaseNetting() {
	loadedNetting.Lock()
	loadedNetting.dir, loadedNetting.ccs, loadedNetting.pk = "", nil, nil
	loadedNetting.Unlock()
	runtime.GC()
	debug.FreeOSMemory()
}

// ProveNetting proves a netting from the witness wire (netting.EncodeWitness) with the keys in keyDir. It checks
// the witness natively first and never writes it anywhere; the key is read once per directory.
func ProveNetting(witness []byte, keyDir string) (out []byte, err error) {
	defer guard(&err)
	st, slots, err := netting.DecodeWitness(witness)
	if err != nil {
		return nil, err
	}
	assignment, err := netting.Assign(st, slots)
	if err != nil {
		return nil, err
	}
	full, err := frontend.NewWitness(assignment, ecc.BN254.ScalarField())
	if err != nil {
		return nil, err
	}
	loadedNetting.Lock()
	defer loadedNetting.Unlock()
	if loadedNetting.dir != keyDir || loadedNetting.pk == nil {
		loadedNetting.dir, loadedNetting.ccs, loadedNetting.pk = "", nil, nil
		ccs, pk, err := readKeys(keyDir)
		if errors.Is(err, fs.ErrNotExist) {
			return nil, fmt.Errorf("%w: %v", ErrNoKey, err)
		}
		if err != nil {
			return nil, err
		}
		loadedNetting.dir, loadedNetting.ccs, loadedNetting.pk = keyDir, ccs, pk
	}
	proof, err := groth16.Prove(loadedNetting.ccs, loadedNetting.pk, full)
	if err != nil {
		return nil, err
	}
	return proofenc.RawPlain(proof)
}

// VerifyNetting checks a raw proof against the four public inputs (4 × 32 bytes, big-endian) under the
// verifying key at vkPath. It reports false for a well-formed proof that does not verify and an error for
// bytes that are not a proof.
func VerifyNetting(proof, public []byte, vkPath string) (ok bool, err error) {
	defer guard(&err)
	if len(proof) != NettingProofLen || len(public) != netting.NumPublic*32 {
		return false, fmt.Errorf("proof of %d bytes and public inputs of %d bytes", len(proof), len(public))
	}
	var p groth16bn254.Proof
	if _, err := p.Ar.SetBytes(proof[0:64]); err != nil {
		return false, err
	}
	if _, err := p.Bs.SetBytes(proof[64:192]); err != nil {
		return false, err
	}
	if _, err := p.Krs.SetBytes(proof[192:256]); err != nil {
		return false, err
	}
	vk := groth16.NewVerifyingKey(ecc.BN254)
	f, err := os.Open(vkPath)
	if err != nil {
		return false, err
	}
	defer f.Close()
	if _, err := vk.ReadFrom(f); err != nil {
		return false, err
	}
	vals := make([]frontend.Variable, netting.NumPublic)
	for i := range vals {
		v := new(big.Int).SetBytes(public[i*32 : (i+1)*32])
		if v.Cmp(ecc.BN254.ScalarField()) >= 0 {
			return false, fmt.Errorf("public input %d is not canonical", i)
		}
		vals[i] = v
	}
	pub, err := frontend.NewWitness(&netting.Netting{Session: vals[0], Participants: vals[1], Total: vals[2], Root: vals[3]},
		ecc.BN254.ScalarField(), frontend.PublicOnly())
	if err != nil {
		return false, err
	}
	if err := groth16.Verify(&p, vk, pub); err != nil {
		return false, nil
	}
	return true, nil
}
