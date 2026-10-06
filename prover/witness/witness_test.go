package witness_test

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	"github.com/DavidZapataOh/buckspay/prover/witness"
)

func load(t *testing.T) *witness.Vectors {
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

func TestOutputIDsFromPublicDataOnly(t *testing.T) {
	for _, c := range load(t).Valid {
		ids, err := witness.OutputIDs(c.Chain())
		if err != nil {
			t.Fatal(err)
		}
		for i := range ids {
			if hex.EncodeToString(ids[i][:]) != c.OutputIDs[i][c.NextBit(i)] {
				t.Fatalf("%s/%d", c.Name, i)
			}
		}
	}
}

func TestSameOutputDifferentContentConflicts(t *testing.T) {
	v := load(t)
	a := v.ByName("issue_plus_2").Chain()
	b := v.ByName("issue_plus_2_branch").Chain()
	ia, err := witness.OutputIDs(a)
	if err != nil {
		t.Fatal(err)
	}
	ib, err := witness.OutputIDs(b)
	if err != nil {
		t.Fatal(err)
	}
	if ia[1] != ib[1] {
		t.Fatal("both branches consume the same output, so the consumed id must be equal")
	}
	if witness.Content(a, 2) == witness.Content(b, 2) {
		t.Fatal("the branches must differ in CONTENT so the second settlement conflicts")
	}
}
