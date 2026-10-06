package circuit_test

import (
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark/frontend"

	"github.com/DavidZapataOh/buckspay/prover/circuit"
	"github.com/DavidZapataOh/buckspay/prover/witness"
)

// The FFT domain of the proving key is the next power of two above the constraint count. The
// circuit crosses 2^19 (524,288) with the key checks it needs, so the domain is 2^20: measured on
// an 8 vCPU x86 server, a proof takes about 3 s and 1.3 GB at 2^20. Both bounds change only in a
// commit that records the new measurements, and no check is removed to fit.
const (
	margin         = 8_192
	maxConstraints = 1<<20 - margin
	minConstraints = 526_478 // the count with every check in place
)

func TestConstraintBudget(t *testing.T) {
	n := compiled(t).GetNbConstraints()
	t.Logf("constraints=%d", n)
	if n > maxConstraints {
		t.Fatalf("constraint budget exceeded: %d > %d. Never remove or weaken a check to fit. Measure the next domain (proving time and peak RAM), record it, then raise maxConstraints to that domain minus the margin", n, maxConstraints)
	}
	if n < minConstraints {
		t.Fatalf("%d constraints, fewer than the reviewed %d: a check may have been removed; review the rules and the vectors before lowering minConstraints", n, minConstraints)
	}
}

func TestPublicWitnessHasTenElements(t *testing.T) {
	a, err := witness.Assign(vectors(t).Valid[0].Chain(), 0)
	if err != nil {
		t.Fatal(err)
	}
	w, err := frontend.NewWitness(a, ecc.BN254.ScalarField(), frontend.PublicOnly())
	if err != nil {
		t.Fatal(err)
	}
	if got := len(w.Vector().(fr.Vector)); got != circuit.NumPublic {
		t.Fatalf("public witness has %d elements", got)
	}
}
