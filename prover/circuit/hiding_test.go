package circuit_test

import (
	"crypto/sha256"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend"
	"github.com/consensys/gnark/backend/groth16"
	groth16bn254 "github.com/consensys/gnark/backend/groth16/bn254"
	"github.com/consensys/gnark/frontend"

	"github.com/DavidZapataOh/buckspay/prover/witness"
)

func TestCommitmentIsHiding(t *testing.T) {
	if testing.Short() {
		t.Skip("full setup")
	}
	pk, _ := setupKeys(t)
	ccs := compiled(t)
	a, err := witness.Assign(vectors(t).ByName("issue_plus_2_branch").Chain(), 1)
	if err != nil {
		t.Fatal(err)
	}
	full, err := frontend.NewWitness(a, ecc.BN254.ScalarField())
	if err != nil {
		t.Fatal(err)
	}
	var p [2]*groth16bn254.Proof
	for i := range p {
		proof, err := groth16.Prove(ccs, pk, full, backend.WithProverHashToFieldFunction(sha256.New()))
		if err != nil {
			t.Fatal(err)
		}
		p[i] = proof.(*groth16bn254.Proof)
	}
	if len(p[0].Commitments) != 1 {
		t.Fatalf("expected one BSB22 commitment, got %d", len(p[0].Commitments))
	}
	if p[0].Commitments[0].Equal(&p[1].Commitments[0]) || p[0].CommitmentPok.Equal(&p[1].CommitmentPok) {
		t.Fatal("D or its Pok is deterministic in the witness: observers could dictionary-test committed wires")
	}
	t.Logf("committed wires: %v", ccs.GetCommitments().CommitmentIndexes())
}
