package circuit_test

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/constraint/solver"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"

	"github.com/DavidZapataOh/buckspay/prover/circuit"
	"github.com/DavidZapataOh/buckspay/prover/witness"
)

var reasons = []string{
	"wrong_signer", "other_issuer_key", "high_s", "altered_s_in", "altered_e",
	"amount0_not_below_input", "hops_not_decreasing", "expiry_extended", "merchant_scope",
	"no_lock_without_delegation", "last_pays_a_device", "altered_payment_amount",
	"change_to_other_key", "key_x_not_below_p",
	"r_zero", "s_zero", "r_not_below_n", "s_not_below_n", "recovered_point_at_infinity",
}

func vectors(t *testing.T) *witness.Vectors {
	t.Helper()
	raw, err := os.ReadFile("../testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v witness.Vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return &v
}

var (
	compileOnce sync.Once
	compiledCCS constraint.ConstraintSystem
	compileErr  error
)

// compiled returns the constraint system the prover uses, built once per test binary.
func compiled(t *testing.T) constraint.ConstraintSystem {
	t.Helper()
	compileOnce.Do(func() {
		compiledCCS, compileErr = frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &circuit.Message{})
	})
	if compileErr != nil {
		t.Fatal(compileErr)
	}
	return compiledCCS
}

func solve(t *testing.T, a *circuit.Message, opts ...solver.Option) error {
	t.Helper()
	w, err := frontend.NewWitness(a, ecc.BN254.ScalarField())
	if err != nil {
		t.Fatal(err)
	}
	return compiled(t).IsSolved(w, opts...)
}

var (
	setupOnce sync.Once
	setupPK   groth16.ProvingKey
	setupVK   groth16.VerifyingKey
	setupErr  error
)

// setupKeys runs one single-party Groth16 setup for the whole test binary. The keys are test-only and never leave memory.
func setupKeys(t *testing.T) (groth16.ProvingKey, groth16.VerifyingKey) {
	t.Helper()
	ccs := compiled(t)
	setupOnce.Do(func() { timed(t, "single-party setup", func() { setupPK, setupVK, setupErr = groth16.Setup(ccs) }) })
	if setupErr != nil {
		t.Fatal(setupErr)
	}
	return setupPK, setupVK
}

// peakRSS is the process high-water mark in kB from /proc, or 0 where it is not available.
func peakRSS() int {
	raw, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if rest, ok := strings.CutPrefix(line, "VmHWM:"); ok {
			var kb int
			fmt.Sscanf(strings.TrimSpace(rest), "%d", &kb)
			return kb
		}
	}
	return 0
}

func timed(t *testing.T, what string, f func()) {
	t.Helper()
	start := time.Now()
	f()
	t.Logf("%s: %s, peak RSS %d MB", what, time.Since(start).Round(time.Millisecond), peakRSS()/1024)
}
