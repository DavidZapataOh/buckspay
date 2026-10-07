package mobile

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark/backend"
	"github.com/consensys/gnark/backend/groth16"
	groth16bn254 "github.com/consensys/gnark/backend/groth16/bn254"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"

	"github.com/DavidZapataOh/buckspay/prover/claim"
	"github.com/DavidZapataOh/buckspay/prover/keys"
	"github.com/DavidZapataOh/buckspay/prover/proofenc"
)

var (
	claimKeysOnce sync.Once
	claimKeysDir  string
	claimKeysErr  error
)

// claimKeys returns a directory of throwaway claim keys: the one named by BUCKSPAY_CLAIM_TEST_KEYS, or a fresh
// single-party setup shared by the tests of this package.
func claimKeys(t *testing.T) string {
	t.Helper()
	if dir := os.Getenv("BUCKSPAY_CLAIM_TEST_KEYS"); dir != "" {
		return dir
	}
	claimKeysOnce.Do(func() {
		claimKeysDir, claimKeysErr = os.MkdirTemp("", "buckspay-claim-keys")
		if claimKeysErr != nil {
			return
		}
		var ccs constraint.ConstraintSystem
		ccs, claimKeysErr = frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &claim.Claim{})
		if claimKeysErr != nil {
			return
		}
		pk, vk, err := groth16.Setup(ccs)
		if err != nil {
			claimKeysErr = err
			return
		}
		_, claimKeysErr = keys.Store(claimKeysDir, ccs, pk, vk, keys.Manifest{Test: true})
	})
	if claimKeysErr != nil {
		t.Fatal(claimKeysErr)
	}
	return claimKeysDir
}

type claimVectors struct {
	Derivations []struct {
		Nullifier, Trapdoor string
		Exp                 uint8
		Scope               string
		NullifierHash       string `json:"nullifier_hash"`
	}
	Root  string
	Paths []struct {
		Index    int
		Siblings []string
	}
}

func slice(a [32]byte) []byte { return a[:] }

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func loadClaimVectors(t *testing.T) claimVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "testdata", "claim-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v claimVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

type claimRequest struct {
	root, scope, recipient []byte
	maxFee                 *big.Int
	exp                    byte
	nullifier, trapdoor    []byte
	index                  uint32
	siblings               [][]byte
}

func (r claimRequest) bytes() []byte {
	var b bytes.Buffer
	b.Write(r.root)
	b.Write(r.scope)
	b.Write(r.recipient)
	b.Write(r.maxFee.FillBytes(make([]byte, maxFeeLen)))
	b.WriteByte(r.exp)
	b.Write(r.nullifier)
	b.Write(r.trapdoor)
	b.Write(binary.BigEndian.AppendUint32(nil, r.index))
	for _, s := range r.siblings {
		b.Write(s)
	}
	return b.Bytes()
}

func vectorRequest(t *testing.T, which int) claimRequest {
	t.Helper()
	v := loadClaimVectors(t)
	p := v.Paths[which]
	d := v.Derivations[p.Index]
	r := claimRequest{
		root: unhex(t, v.Root), scope: unhex(t, d.Scope), recipient: bytes.Repeat([]byte{0xAB}, 32),
		maxFee: big.NewInt(900_000), exp: d.Exp, nullifier: unhex(t, d.Nullifier), trapdoor: unhex(t, d.Trapdoor),
		index: uint32(p.Index),
	}
	for _, s := range p.Siblings {
		r.siblings = append(r.siblings, unhex(t, s))
	}
	return r
}

func verifyClaim(t *testing.T, vkPath string, comp, pub []byte) error {
	t.Helper()
	var p groth16bn254.Proof
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
	vk := groth16.NewVerifyingKey(ecc.BN254)
	f, err := os.Open(vkPath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := vk.ReadFrom(f); err != nil {
		t.Fatal(err)
	}
	var v [claim.NumPublic]*big.Int
	for i := range v {
		v[i] = new(big.Int).SetBytes(pub[i*32 : (i+1)*32])
	}
	w, err := frontend.NewWitness(&claim.Claim{
		Root: v[0], NullifierHash: v[1], Scope: v[2], RecipientHi: v[3], RecipientLo: v[4], Exp: v[5], MaxFee: v[6],
	}, ecc.BN254.ScalarField(), frontend.PublicOnly())
	if err != nil {
		t.Fatal(err)
	}
	return groth16.Verify(&p, vk, w, backend.WithVerifierHashToFieldFunction(sha256.New()))
}

func TestProveClaimWithoutKeyFails(t *testing.T) {
	ReleaseClaim()
	if _, err := ProveClaim(vectorRequest(t, 0).bytes()); !errors.Is(err, ErrNoKey) {
		t.Fatalf("got %v, want ErrNoKey", err)
	}
}

func TestProveClaimIsAcceptedByTheVerifierAndStatesTheClaim(t *testing.T) {
	dir := claimKeys(t)
	if err := LoadClaim(dir); err != nil {
		t.Fatal(err)
	}
	defer ReleaseClaim()
	v := loadClaimVectors(t)
	for i := range v.Paths {
		r := vectorRequest(t, i)
		out, err := ProveClaim(r.bytes())
		if err != nil {
			t.Fatal(err)
		}
		if len(out) != ClaimProofLen+ClaimPublicLen {
			t.Fatalf("len %d", len(out))
		}
		pub := out[ClaimProofLen:]
		hi, lo := claim.SplitRecipient([32]byte(r.recipient))
		want := [][]byte{
			r.root, unhex(t, v.Derivations[v.Paths[i].Index].NullifierHash), r.scope, hi.Marshal(), lo.Marshal(),
			slice(word(big.NewInt(int64(r.exp)))), slice(word(r.maxFee)),
		}
		for k, w := range want {
			if !bytes.Equal(pub[k*32:(k+1)*32], w) {
				t.Fatalf("path %d: public input %d is %x, want %x", i, k, pub[k*32:(k+1)*32], w)
			}
		}
		if err := verifyClaim(t, filepath.Join(dir, "vk.bin"), out[:ClaimProofLen], pub); err != nil {
			t.Fatalf("path %d: %v", i, err)
		}
	}
}

func TestProveClaimRefusesEveryBadRequestBeforeProving(t *testing.T) {
	ReleaseClaim()
	rBytes := word(fr.Modulus())
	cases := map[string]func(r *claimRequest) []byte{
		"short":                    func(r *claimRequest) []byte { return r.bytes()[:100] },
		"long":                     func(r *claimRequest) []byte { return append(r.bytes(), 0) },
		"exponent above the max":   func(r *claimRequest) []byte { r.exp = claim.MaxExp + 1; return r.bytes() },
		"index outside the tree":   func(r *claimRequest) []byte { r.index |= 1 << claim.Depth; return r.bytes() },
		"root not canonical":       func(r *claimRequest) []byte { r.root = rBytes[:]; return r.bytes() },
		"nullifier not canonical":  func(r *claimRequest) []byte { r.nullifier = rBytes[:]; return r.bytes() },
		"scope not canonical":      func(r *claimRequest) []byte { r.scope = bytes.Repeat([]byte{0xFF}, 32); return r.bytes() },
		"sibling not canonical":    func(r *claimRequest) []byte { r.siblings[3] = rBytes[:]; return r.bytes() },
		"zero nullifier":           func(r *claimRequest) []byte { r.nullifier = make([]byte, 32); return r.bytes() },
		"zero trapdoor":            func(r *claimRequest) []byte { r.trapdoor = make([]byte, 32); return r.bytes() },
		"another root":             func(r *claimRequest) []byte { r.root = r.siblings[0]; return r.bytes() },
		"one wrong sibling":        func(r *claimRequest) []byte { r.siblings[7] = r.siblings[8]; return r.bytes() },
		"the other side of a node": func(r *claimRequest) []byte { r.index ^= 1; return r.bytes() },
		"swapped secrets":          func(r *claimRequest) []byte { r.nullifier, r.trapdoor = r.trapdoor, r.nullifier; return r.bytes() },
		"another exponent":         func(r *claimRequest) []byte { r.exp = (r.exp + 1) % 8; return r.bytes() },
	}
	reasons := map[string]string{
		"exponent above the max": "exponent",
		"index outside the tree": "outside the tree",
		"zero nullifier":         "zero",
		"zero trapdoor":          "zero",
		"short":                  "claim request of",
		"long":                   "claim request of",
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			r := vectorRequest(t, 1)
			out, err := ProveClaim(mutate(&r))
			if err == nil || errors.Is(err, ErrNoKey) || out != nil {
				t.Fatalf("got %x, %v: a bad request must be refused before the key is needed", out, err)
			}
			if want := reasons[name]; want != "" && !strings.Contains(err.Error(), want) {
				t.Fatalf("got %q, want it to say %q", err, want)
			}
		})
	}
}

func TestReleaseClaimDropsTheKey(t *testing.T) {
	if err := LoadClaim(claimKeys(t)); err != nil {
		t.Fatal(err)
	}
	ReleaseClaim()
	if _, err := ProveClaim(vectorRequest(t, 0).bytes()); !errors.Is(err, ErrNoKey) {
		t.Fatalf("got %v, want ErrNoKey", err)
	}
}

func TestLoadClaimReportsAMissingKey(t *testing.T) {
	if err := LoadClaim(t.TempDir()); err == nil {
		t.Fatal("an empty directory holds no key")
	}
}

// The app builds the same requests and expects the same public inputs: both sides read this file.
func TestClaimRequestsMatchTheSharedFixture(t *testing.T) {
	type entry struct {
		Index   int    `json:"index"`
		Request string `json:"request"`
		Publics string `json:"publics"`
	}
	path := filepath.Join("..", "testdata", "claim-requests.json")
	v := loadClaimVectors(t)
	var got []entry
	for i := range v.Paths {
		r := vectorRequest(t, i)
		_, pub, err := assignClaim([32]byte(r.root), [32]byte(r.scope), [32]byte(r.recipient), [32]byte(r.nullifier), [32]byte(r.trapdoor), r.maxFee, r.exp, int(r.index), bytes.Join(r.siblings, nil))
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, entry{int(r.index), hex.EncodeToString(r.bytes()), hex.EncodeToString(pub)})
	}
	if os.Getenv("UPDATE_CLAIM_REQUESTS") != "" {
		out, err := json.MarshalIndent(got, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(out, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var want []entry
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if len(want) != len(got) {
		t.Fatalf("%d entries, want %d", len(got), len(want))
	}
	for i := range want {
		if want[i] != got[i] {
			t.Fatalf("entry %d differs from the fixture", i)
		}
	}
}
