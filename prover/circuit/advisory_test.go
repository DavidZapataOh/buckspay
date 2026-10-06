package circuit_test

import (
	"os/exec"
	"testing"
)

// The BSB22 commitment of the circuit must hide its committed wires. gnark ships the regression
// test of the advisory that fixed a non-hiding commitment (GHSA-9xcg-3q8v-7fq6) in an internal
// package, so it is run in the pinned module instead of being copied.
func TestGnarkAdvisory9xcgRegression(t *testing.T) {
	out, err := exec.Command("go", "test", "-count=1", "github.com/consensys/gnark/internal/security_tests/advisory-9xcg").CombinedOutput()
	if err != nil {
		t.Fatalf("gnark's regression test for GHSA-9xcg-3q8v-7fq6 fails on the pinned version:\n%s", out)
	}
}
