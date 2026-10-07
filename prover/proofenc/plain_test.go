package proofenc_test

import (
	"math/big"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"

	"github.com/DavidZapataOh/buckspay/prover/claim"
	"github.com/DavidZapataOh/buckspay/prover/proofenc"
)

func TestPlainProofLayouts(t *testing.T) {
	ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &claim.Claim{})
	if err != nil {
		t.Fatal(err)
	}
	pk, _, err := groth16.Setup(ccs)
	if err != nil {
		t.Fatal(err)
	}
	tree := &claim.Tree{Leaves: make([]fr.Element, 1)}
	in := claim.Inputs{MaxFee: big.NewInt(1), Exp: 1, Nullifier: [32]byte{31: 1}, Trapdoor: [32]byte{31: 2}}
	n, _ := claim.FromCanonical(in.Nullifier)
	d, _ := claim.FromCanonical(in.Trapdoor)
	tree.Leaves[0] = claim.Leaf(claim.Inner(n, d), in.Exp)
	c, err := claim.Assign(tree, in)
	if err != nil {
		t.Fatal(err)
	}
	w, err := frontend.NewWitness(c, ecc.BN254.ScalarField())
	if err != nil {
		t.Fatal(err)
	}
	proof, err := groth16.Prove(ccs, pk, w)
	if err != nil {
		t.Fatal(err)
	}
	comp, err := proofenc.CompressPlain(proof)
	if err != nil || len(comp) != proofenc.PlainCompressedLen {
		t.Fatalf("compressed: %d bytes, %v", len(comp), err)
	}
	raw, err := proofenc.RawPlain(proof)
	if err != nil || len(raw) != proofenc.PlainRawLen {
		t.Fatalf("raw: %d bytes, %v", len(raw), err)
	}
	if _, err := proofenc.Compress(proof); err == nil {
		t.Fatal("the one-commitment layout accepted a proof without a commitment")
	}
}
