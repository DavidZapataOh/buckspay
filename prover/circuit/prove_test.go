package circuit_test

import (
	"crypto/sha256"
	"fmt"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/frontend"

	"github.com/DavidZapataOh/buckspay/prover/witness"
)

func TestProveVerifyOneChain(t *testing.T) {
	if testing.Short() {
		t.Skip("full setup")
	}
	pk, vk := setupKeys(t)
	ccs := compiled(t)
	chain := vectors(t).ByName("issue_plus_2_branch").Chain()
	for i := 0; i < 3; i++ {
		a, err := witness.Assign(chain, i)
		if err != nil {
			t.Fatal(err)
		}
		full, err := frontend.NewWitness(a, ecc.BN254.ScalarField())
		if err != nil {
			t.Fatal(err)
		}
		var proof groth16.Proof
		timed(t, fmt.Sprintf("prove message %d", i), func() {
			proof, err = groth16.Prove(ccs, pk, full, backend.WithProverHashToFieldFunction(sha256.New()))
		})
		if err != nil {
			t.Fatal(err)
		}
		pub, err := full.Public()
		if err != nil {
			t.Fatal(err)
		}
		if err := groth16.Verify(proof, vk, pub, backend.WithVerifierHashToFieldFunction(sha256.New())); err != nil {
			t.Fatal(err)
		}
	}
}
