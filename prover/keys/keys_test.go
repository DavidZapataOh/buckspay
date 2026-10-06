package keys_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"

	"github.com/DavidZapataOh/buckspay/prover/keys"
)

// tenPublics has the public shape of the real circuit: ten public inputs and one BSB22 commitment.
type tenPublics struct {
	P [10]frontend.Variable `gnark:",public"`
	X frontend.Variable
}

func (c *tenPublics) Define(api frontend.API) error {
	cm, err := api.(frontend.Committer).Commit(c.X)
	if err != nil {
		return err
	}
	api.AssertIsDifferent(cm, 0)
	sum := frontend.Variable(0)
	for _, p := range c.P {
		sum = api.Add(sum, api.Mul(p, p))
	}
	api.AssertIsEqual(sum, api.Mul(c.X, c.X))
	return nil
}

type ninePublics struct {
	P [9]frontend.Variable `gnark:",public"`
	X frontend.Variable
}

func (c *ninePublics) Define(api frontend.API) error {
	cm, err := api.(frontend.Committer).Commit(c.X)
	if err != nil {
		return err
	}
	api.AssertIsDifferent(cm, 0)
	sum := frontend.Variable(0)
	for _, p := range c.P {
		sum = api.Add(sum, api.Mul(p, p))
	}
	api.AssertIsEqual(sum, api.Mul(c.X, c.X))
	return nil
}

func setup(t *testing.T, c frontend.Circuit) (constraint.ConstraintSystem, groth16.ProvingKey, groth16.VerifyingKey) {
	t.Helper()
	ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, c)
	if err != nil {
		t.Fatal(err)
	}
	pk, vk, err := groth16.Setup(ccs) // throwaway keys of a test circuit, never used elsewhere
	if err != nil {
		t.Fatal(err)
	}
	return ccs, pk, vk
}

func fileSHA256(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// rustBytes formats a digest as the comma separated hex bytes of a Rust array literal.
func rustBytes(b []byte) string {
	parts := make([]string, len(b))
	for i, v := range b {
		parts[i] = fmt.Sprintf("0x%02x", v)
	}
	return strings.Join(parts, ", ")
}

func TestExportRustIsStableAndHashed(t *testing.T) {
	_, _, vk := setup(t, &tenPublics{})
	var a, b bytes.Buffer
	if err := keys.ExportRust(vk, &a); err != nil {
		t.Fatal(err)
	}
	if err := keys.ExportRust(vk, &b); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a.Bytes(), b.Bytes()) {
		t.Fatal("export must be deterministic")
	}
	var raw bytes.Buffer
	_, _ = vk.WriteTo(&raw)
	sum := sha256.Sum256(raw.Bytes())
	if !strings.Contains(a.String(), rustBytes(sum[:])) {
		t.Fatal("VK_SHA256 must be the SHA-256 of vk.bin")
	}
	for _, name := range []string{"ALPHA_G1", "BETA_G2", "GAMMA_G2", "DELTA_G2", "IC", "COMMITMENT_KEY_G", "COMMITMENT_KEY_G_SIGMA_NEG"} {
		if !strings.Contains(a.String(), "pub const "+name+":") {
			t.Fatalf("missing %s", name)
		}
	}
}

func TestExportRustRefusesWrongShape(t *testing.T) {
	_, _, vk := setup(t, &ninePublics{})
	if err := keys.ExportRust(vk, io.Discard); err == nil {
		t.Fatal("a VK whose IC length is not 12 must not be exported")
	}
}

func TestManifestHashesEveryArtifact(t *testing.T) {
	ccs, pk, vk := setup(t, &tenPublics{})
	dir := t.TempDir()
	m, err := keys.Store(dir, ccs, pk, vk, keys.Manifest{Beacon: "00"})
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"pk.bin": m.PKBinSHA256, "pk.dump": m.PKDumpSHA256, "vk.bin": m.VKSHA256, "ccs.bin": m.CCSSHA256} {
		if fileSHA256(t, filepath.Join(dir, name)) != want {
			t.Fatalf("%s hash mismatch", name)
		}
	}
	if m.Constraints != ccs.GetNbConstraints() {
		t.Fatalf("manifest records %d constraints, the system has %d", m.Constraints, ccs.GetNbConstraints())
	}
	if fileSHA256(t, filepath.Join(dir, "manifest.json")) == "" {
		t.Fatal("manifest.json is not written")
	}
}

func TestExportRustMarksTestKeys(t *testing.T) {
	_, _, vk := setup(t, &tenPublics{})
	var prod, test bytes.Buffer
	if err := keys.ExportRust(vk, &prod); err != nil {
		t.Fatal(err)
	}
	if err := keys.ExportRust(vk, &test, keys.TestKeys()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(prod.String(), "pub const TEST_KEYS: bool = false;") {
		t.Fatal("a key exported without the option must not be marked as a test key")
	}
	if !strings.Contains(test.String(), "pub const TEST_KEYS: bool = true;") {
		t.Fatal("a test key must say so")
	}
}
