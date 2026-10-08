package mobile

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"

	"github.com/DavidZapataOh/buckspay/prover/keys"
	"github.com/DavidZapataOh/buckspay/prover/netting"
)

func nettingKeys(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &netting.Netting{})
	if err != nil {
		t.Fatal(err)
	}
	pk, vk, err := groth16.Setup(ccs)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := keys.Store(dir, ccs, pk, vk, keys.Manifest{Test: true}); err != nil {
		t.Fatal(err)
	}
	return dir
}

func publicBytes(st netting.Statement) []byte {
	var out []byte
	for _, p := range st.Public() {
		out = append(out, p[:]...)
	}
	return out
}

func TestProveNettingVerifiesAndRefusesAlterations(t *testing.T) {
	dir := nettingKeys(t)
	vk := filepath.Join(dir, keys.VKFile)
	for _, n := range []int{2, 5, 8} {
		st, slots := netting.Example(n)
		proof, err := ProveNetting(netting.EncodeWitness(st, slots), dir)
		if err != nil {
			t.Fatal(err)
		}
		if len(proof) != NettingProofLen {
			t.Fatalf("proof of %d bytes", len(proof))
		}
		pub := publicBytes(st)
		if ok, err := VerifyNetting(proof, pub, vk); err != nil || !ok {
			t.Fatalf("n=%d: honest proof refused: %v", n, err)
		}
		for _, at := range []int{0, 70, 200, 255} {
			bad := append([]byte{}, proof...)
			bad[at] ^= 1
			if ok, _ := VerifyNetting(bad, pub, vk); ok {
				t.Fatalf("proof with byte %d flipped verifies", at)
			}
		}
		for i := 0; i < netting.NumPublic; i++ {
			alt := append([]byte{}, pub...)
			alt[32*i+31] ^= 1
			if ok, _ := VerifyNetting(proof, alt, vk); ok {
				t.Fatalf("public %d altered verifies", i)
			}
		}
	}
}

func TestProveNettingRefusesBadWitness(t *testing.T) {
	dir := nettingKeys(t)
	st, slots := netting.Example(5)
	wire := netting.EncodeWitness(st, slots)
	if _, err := ProveNetting(wire[:len(wire)-1], dir); err == nil {
		t.Fatal("short witness proved")
	}
	st.Root[31] ^= 1
	if _, err := ProveNetting(netting.EncodeWitness(st, slots), dir); !errors.Is(err, netting.ErrWitness) {
		t.Fatalf("root mismatch: %v", err)
	}
	if _, err := ProveNetting(wire, t.TempDir()); !errors.Is(err, ErrNoKey) {
		t.Fatalf("missing keys: %v", err)
	}
}
