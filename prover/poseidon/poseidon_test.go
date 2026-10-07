package poseidon

import (
	"encoding/hex"
	"encoding/json"
	"math/big"
	"os"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/test"
)

// testdata/sol_poseidon.json comes from `cargo run -p buckspay-zk-verify --example poseidon-vectors`,
// which calls solana_poseidon::hashv (Bn254X5, big-endian), the padded path the syscall runs.
type vector struct {
	Inputs []string `json:"inputs"`
	Out    string   `json:"out"`
	Err    bool     `json:"err"`
}

func load(t *testing.T) []vector {
	t.Helper()
	raw, err := os.ReadFile("testdata/sol_poseidon.json")
	if err != nil {
		t.Fatal(err)
	}
	var v []vector
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v) < 64 {
		t.Fatalf("only %d vectors", len(v))
	}
	return v
}

func element(t *testing.T, s string) fr.Element {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	var e fr.Element
	e.SetBigInt(new(big.Int).SetBytes(b))
	return e
}

func TestNativeMatchesSolPoseidon(t *testing.T) {
	n := 0
	for i, v := range load(t) {
		if v.Err || len(v.Inputs) != 2 {
			continue
		}
		got := Native(element(t, v.Inputs[0]), element(t, v.Inputs[1]))
		want := element(t, v.Out)
		if !got.Equal(&want) {
			t.Fatalf("vector %d: %s != %s", i, got.String(), want.String())
		}
		n++
	}
	if n < 40 {
		t.Fatalf("only %d arity-2 vectors compared", n)
	}
}

type hashCircuit struct{ A, B, Out frontend.Variable }

func (c *hashCircuit) Define(api frontend.API) error {
	api.AssertIsEqual(Hash(api, c.A, c.B), c.Out)
	return nil
}

func TestCircuitMatchesSolPoseidon(t *testing.T) {
	assert := test.NewAssert(t)
	for _, v := range load(t) {
		if len(v.Inputs) != 2 || v.Err {
			continue
		}
		a, b, out := element(t, v.Inputs[0]), element(t, v.Inputs[1]), element(t, v.Out)
		var wrong fr.Element
		wrong.Add(&out, new(fr.Element).SetOne())
		assert.CheckCircuit(&hashCircuit{},
			test.WithValidAssignment(&hashCircuit{A: a, B: b, Out: out}),
			test.WithInvalidAssignment(&hashCircuit{A: a, B: b, Out: wrong}),
			test.WithCurves(ecc.BN254), test.NoSerializationChecks(), test.NoFuzzing())
	}
}

func TestRefusedVectorsAreRecorded(t *testing.T) {
	refused := 0
	for _, v := range load(t) {
		if v.Err {
			refused++
		}
	}
	if refused < 2 {
		t.Fatalf("%d non-canonical vectors recorded", refused)
	}
}
