package keys_test

import (
	"bytes"
	"strings"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"

	"github.com/DavidZapataOh/buckspay/prover/claim"
	"github.com/DavidZapataOh/buckspay/prover/keys"
)

func TestExportClaimKeyHasNoCommitmentAndEightIC(t *testing.T) {
	ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &claim.Claim{})
	if err != nil {
		t.Fatal(err)
	}
	_, vk, err := groth16.Setup(ccs)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := keys.ExportRust(vk, &out, keys.Claim(), keys.TestKeys()); err != nil {
		t.Fatal(err)
	}
	src := out.String()
	for _, want := range []string{"NUM_PUBLIC: usize = 7", "IC: [[u8; 64]; 8]", "TEST_KEYS: bool = true", "IC.len() == NUM_PUBLIC + 1"} {
		if !strings.Contains(src, want) {
			t.Fatalf("missing %q", want)
		}
	}
	if strings.Contains(src, "COMMITMENT") {
		t.Fatal("the claim key has no commitment")
	}
	if err := keys.ExportRust(vk, &out); err == nil {
		t.Fatal("the per-message shape accepted the claim key")
	}
}
