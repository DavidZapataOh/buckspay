package mobile

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"math/big"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/consensys/gnark/backend"
	"github.com/consensys/gnark/backend/groth16"
	groth16bn254 "github.com/consensys/gnark/backend/groth16/bn254"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"

	"github.com/DavidZapataOh/buckspay/prover/circuit"
	"github.com/DavidZapataOh/buckspay/prover/keys"
	"github.com/DavidZapataOh/buckspay/prover/proofenc"
	"github.com/DavidZapataOh/buckspay/prover/witness"
)

var (
	keysOnce sync.Once
	keysDir  string
	keysErr  error
)

// testKeys returns a directory of throwaway keys (ccs.bin, pk.bin, pk.dump, vk.bin): the one named by
// BUCKSPAY_ZK_TEST_KEYS, or a fresh single-party setup shared by the tests of this package.
func testKeys(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("needs a full setup")
	}
	if dir := os.Getenv("BUCKSPAY_ZK_TEST_KEYS"); dir != "" {
		return dir
	}
	keysOnce.Do(func() {
		keysDir, keysErr = os.MkdirTemp("", "buckspay-mobile-keys")
		if keysErr != nil {
			return
		}
		var ccs constraint.ConstraintSystem
		ccs, keysErr = frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &circuit.Message{})
		if keysErr != nil {
			return
		}
		pk, vk, err := groth16.Setup(ccs)
		if err != nil {
			keysErr = err
			return
		}
		_, keysErr = keys.Store(keysDir, ccs, pk, vk, keys.Manifest{Test: true})
	})
	if keysErr != nil {
		t.Fatal(keysErr)
	}
	return keysDir
}

func TestMain(m *testing.M) {
	code := m.Run()
	if keysDir != "" {
		os.RemoveAll(keysDir)
	}
	os.Exit(code)
}

func vectorChain(t *testing.T, name string) *witness.Chain {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "testdata", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v witness.Vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	c := v.ByName(name)
	if c == nil {
		t.Fatalf("no vector %q", name)
	}
	return c.Chain()
}

// encodeChain writes a chain in the wire form DecodeChain reads.
func encodeChain(c *witness.Chain) []byte {
	var b bytes.Buffer
	b.Write(c.Domain[:])
	b.WriteByte(byte(len(c.Messages)))
	for _, m := range c.Messages {
		b.WriteByte(m.Kind)
		b.Write(binary.BigEndian.AppendUint16(nil, uint16(len(m.Body))))
		b.Write(m.Body)
		b.Write(m.R.FillBytes(make([]byte, 32)))
		b.Write(m.S.FillBytes(make([]byte, 32)))
		b.Write(m.Key[:])
	}
	for _, o := range c.Openings {
		b.Write(o.Owner[:])
		b.Write(binary.BigEndian.AppendUint64(nil, o.Amount))
		b.Write(o.Caveats[:])
		b.Write(o.Salt[:])
		b.WriteByte(o.Index)
	}
	return b.Bytes()
}

// verifyCompressed decompresses the layout the Solana verifier reads and checks it with gnark.
func verifyCompressed(t *testing.T, vkPath string, comp, pub []byte) error {
	t.Helper()
	var p groth16bn254.Proof
	p.Commitments = make([]bn254.G1Affine, 1)
	g1 := func(raw []byte, into *bn254.G1Affine) {
		if _, err := into.SetBytes(proofenc.GnarkFlags(append([]byte(nil), raw...))); err != nil {
			t.Fatal(err)
		}
	}
	g1(comp[0:32], &p.Ar)
	if _, err := p.Bs.SetBytes(proofenc.GnarkFlags(append([]byte(nil), comp[32:96]...))); err != nil {
		t.Fatal(err)
	}
	g1(comp[96:128], &p.Krs)
	g1(comp[128:160], &p.Commitments[0])
	g1(comp[160:192], &p.CommitmentPok)
	vk := groth16.NewVerifyingKey(ecc.BN254)
	f, err := os.Open(vkPath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := vk.ReadFrom(f); err != nil {
		t.Fatal(err)
	}
	var v [circuit.NumPublic]frontend.Variable
	for i := range v {
		v[i] = new(big.Int).SetBytes(pub[i*32 : (i+1)*32])
	}
	w, err := frontend.NewWitness(&circuit.Message{
		E: [2]frontend.Variable{v[0], v[1]}, Ctrl: v[2], SIn: v[3], SOut: v[4],
		A: [2]frontend.Variable{v[5], v[6]}, B: [2]frontend.Variable{v[7], v[8]}, Amt: v[9],
	}, ecc.BN254.ScalarField(), frontend.PublicOnly())
	if err != nil {
		t.Fatal(err)
	}
	return groth16.Verify(&p, vk, w, backend.WithVerifierHashToFieldFunction(sha256.New()))
}

func TestProveWithoutKeyFails(t *testing.T) {
	Release()
	if _, err := Prove(encodeChain(vectorChain(t, "issue_plus_2_branch")), 0); err != ErrNoKey {
		t.Fatalf("got %v, want ErrNoKey", err)
	}
}

func TestProveReturnsSolanaCompressedProofAndPublicInputs(t *testing.T) {
	dir := testKeys(t)
	if err := Load(dir); err != nil {
		t.Fatal(err)
	}
	defer Release()
	chain := vectorChain(t, "issue_plus_2_branch")
	out, err := Prove(encodeChain(chain), 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != ProofLen+PublicLen {
		t.Fatalf("len %d", len(out))
	}
	pub, err := witness.PublicBytes(chain, 1)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out[ProofLen:], pub) {
		t.Fatal("public inputs must be the witness package's, big-endian 32 B each")
	}
	if err := verifyCompressed(t, filepath.Join(dir, "vk.bin"), out[:ProofLen], out[ProofLen:]); err != nil {
		t.Fatal(err)
	}
}

func TestExpandGivesTheManifestDump(t *testing.T) {
	dir := testKeys(t)
	dump := filepath.Join(t.TempDir(), "pk.dump")
	if err := Expand(filepath.Join(dir, "pk.bin"), dump); err != nil {
		t.Fatal(err)
	}
	a, _ := os.ReadFile(dump)
	b, _ := os.ReadFile(filepath.Join(dir, "pk.dump"))
	if !bytes.Equal(a, b) {
		t.Fatal("expanding the compressed key must reproduce the published dump byte for byte")
	}
}

func TestMalformedChainIsAnErrorNotAPanic(t *testing.T) {
	dir := testKeys(t)
	if err := Load(dir); err != nil {
		t.Fatal(err)
	}
	defer Release()
	if _, err := Prove([]byte{1, 2, 3}, 0); err == nil {
		t.Fatal("garbage must be refused")
	}
	good := encodeChain(vectorChain(t, "issue_plus_2_branch"))
	if _, err := Prove(good, 9); err == nil {
		t.Fatal("index out of range must be refused")
	}
	if _, err := Prove(good[:len(good)-1], 0); err == nil {
		t.Fatal("a truncated chain must be refused")
	}
}

func TestLoadRefusesAMissingOrShortKey(t *testing.T) {
	dir := t.TempDir()
	if err := Load(dir); err == nil {
		t.Fatal("an empty directory has no key")
	}
	os.WriteFile(filepath.Join(dir, "ccs.bin"), []byte("x"), 0o600)
	os.WriteFile(filepath.Join(dir, "pk.dump"), []byte("x"), 0o600)
	if err := Load(dir); err == nil {
		t.Fatal("a corrupt key must be refused")
	}
	if _, err := Prove(encodeChain(vectorChain(t, "issue_plus_2_branch")), 0); err != ErrNoKey {
		t.Fatalf("a failed load leaves no key: %v", err)
	}
}
