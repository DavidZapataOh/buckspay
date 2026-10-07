package mobile

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
	"runtime"
	"runtime/debug"
	"sync"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark/backend"
	"github.com/consensys/gnark/backend/groth16"
	cs_bn254 "github.com/consensys/gnark/constraint/bn254"
	"github.com/consensys/gnark/frontend"

	"github.com/DavidZapataOh/buckspay/prover/claim"
	"github.com/DavidZapataOh/buckspay/prover/poseidon"
	"github.com/DavidZapataOh/buckspay/prover/proofenc"
)

const (
	// ClaimProofLen is the compressed proof without a commitment; ClaimPublicLen the seven public inputs of a
	// claim, 32 big-endian bytes each.
	ClaimProofLen  = proofenc.PlainCompressedLen
	ClaimPublicLen = claim.NumPublic * 32

	maxFeeLen     = 16
	claimFixedLen = 32 + 32 + 32 + maxFeeLen + 1 + 32 + 32 + 4
	// ClaimRequestLen is the size of the request ProveClaim reads.
	ClaimRequestLen = claimFixedLen + claim.Depth*32
)

var loadedClaim struct {
	sync.Mutex
	ccs *cs_bn254.R1CS
	pk  groth16.ProvingKey
}

// LoadClaim reads the claim circuit and its proving key from dir, replacing any claim key already loaded.
func LoadClaim(dir string) (err error) {
	defer guard(&err)
	ReleaseClaim()
	ccs, pk, err := readKeys(dir)
	if err != nil {
		return err
	}
	loadedClaim.Lock()
	loadedClaim.ccs, loadedClaim.pk = ccs, pk
	loadedClaim.Unlock()
	return nil
}

// ReleaseClaim drops the claim key.
func ReleaseClaim() {
	loadedClaim.Lock()
	loadedClaim.ccs, loadedClaim.pk = nil, nil
	loadedClaim.Unlock()
	runtime.GC()
	debug.FreeOSMemory()
}

// ProveClaim proves a blind claim from the wire form the app writes: root (32), scope (32), recipient (32),
// max fee (16, big-endian), exponent (1), nullifier (32), trapdoor (32), leaf index (4, big-endian) and the
// 20 siblings from the leaf up (32 each). Every field element is a canonical big-endian integer. The result
// is the 128-byte compressed proof followed by the seven public inputs.
func ProveClaim(req []byte) (out []byte, err error) {
	defer guard(&err)
	if len(req) != ClaimRequestLen {
		return nil, fmt.Errorf("claim request of %d bytes, want %d", len(req), ClaimRequestLen)
	}
	var root, scope, recipient, nullifier, trapdoor [32]byte
	copy(root[:], req)
	copy(scope[:], req[32:])
	copy(recipient[:], req[64:])
	maxFee := new(big.Int).SetBytes(req[96 : 96+maxFeeLen])
	exp := req[96+maxFeeLen]
	copy(nullifier[:], req[97+maxFeeLen:])
	copy(trapdoor[:], req[129+maxFeeLen:])
	index := binary.BigEndian.Uint32(req[161+maxFeeLen:])
	if exp > claim.MaxExp {
		return nil, fmt.Errorf("exponent %d above %d", exp, claim.MaxExp)
	}
	if index >= 1<<claim.Depth {
		return nil, fmt.Errorf("leaf index %d outside the tree", index)
	}
	a, pub, err := assignClaim(root, scope, recipient, nullifier, trapdoor, maxFee, exp, int(index), req[claimFixedLen:])
	if err != nil {
		return nil, err
	}
	full, err := frontend.NewWitness(a, ecc.BN254.ScalarField())
	if err != nil {
		return nil, err
	}
	loadedClaim.Lock()
	defer loadedClaim.Unlock()
	if loadedClaim.pk == nil {
		return nil, ErrNoKey
	}
	proof, err := groth16.Prove(loadedClaim.ccs, loadedClaim.pk, full, backend.WithProverHashToFieldFunction(sha256.New()))
	if err != nil {
		return nil, err
	}
	comp, err := proofenc.CompressPlain(proof)
	if err != nil {
		return nil, err
	}
	return append(comp, pub...), nil
}

// assignClaim checks that the secrets open the leaf at index under root through the siblings, and builds the
// witness and the public inputs.
func assignClaim(root, scope, recipient, nullifier, trapdoor [32]byte, maxFee *big.Int, exp uint8, index int, siblings []byte) (*claim.Claim, []byte, error) {
	field := func(name string, b [32]byte) (fr.Element, error) {
		e, err := claim.FromCanonical(b)
		if err != nil {
			return e, fmt.Errorf("%s: %w", name, err)
		}
		return e, nil
	}
	rootE, err := field("root", root)
	if err != nil {
		return nil, nil, err
	}
	scopeE, err := field("scope", scope)
	if err != nil {
		return nil, nil, err
	}
	n, err := field("nullifier", nullifier)
	if err != nil {
		return nil, nil, err
	}
	t, err := field("trapdoor", trapdoor)
	if err != nil {
		return nil, nil, err
	}
	if n.IsZero() || t.IsZero() {
		return nil, nil, errors.New("a leaf secret is zero")
	}
	c := &claim.Claim{Nullifier: n, Trapdoor: t, Scope: scopeE, Root: rootE, Exp: uint64(exp), MaxFee: new(big.Int).Set(maxFee)}
	node := claim.Leaf(claim.Inner(n, t), exp)
	for k := 0; k < claim.Depth; k++ {
		var raw [32]byte
		copy(raw[:], siblings[k*32:])
		sib, err := field(fmt.Sprintf("sibling %d", k), raw)
		if err != nil {
			return nil, nil, err
		}
		bit := uint8(index >> k & 1)
		if bit == 1 {
			node = poseidon.Native(sib, node)
		} else {
			node = poseidon.Native(node, sib)
		}
		c.Path[k], c.Bits[k] = sib, uint64(bit)
	}
	if !node.Equal(&rootE) {
		return nil, nil, errors.New("the path does not lead from this leaf to the root")
	}
	hi, lo := claim.SplitRecipient(recipient)
	nh := claim.NullifierHash(n, scopeE)
	c.NullifierHash, c.RecipientHi, c.RecipientLo = nh, hi, lo
	pub := make([]byte, 0, ClaimPublicLen)
	for _, v := range [][32]byte{root, claim.Bytes32(nh), scope, claim.Bytes32(hi), claim.Bytes32(lo), word(new(big.Int).SetUint64(uint64(exp))), word(maxFee)} {
		pub = append(pub, v[:]...)
	}
	return c, pub, nil
}

func word(v *big.Int) (w [32]byte) {
	v.FillBytes(w[:])
	return
}
