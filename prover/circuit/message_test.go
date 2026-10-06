package circuit_test

import (
	"testing"

	"github.com/DavidZapataOh/buckspay/prover/circuit"
	"github.com/DavidZapataOh/buckspay/prover/witness"
)

func TestValidChainsSolve(t *testing.T) {
	for _, c := range vectors(t).Valid {
		chain := c.Chain()
		for i := range c.Messages {
			a, err := witness.Assign(chain, i)
			if err != nil {
				t.Fatalf("%s/%d: %v", c.Name, i, err)
			}
			if err := solve(t, a); err != nil {
				t.Fatalf("%s/%d: %v", c.Name, i, err)
			}
		}
	}
}

func TestEveryRejectionFails(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range vectors(t).Invalid {
		seen[c.Reason] = true
		a, err := witness.Assign(c.Chain(), c.Bad)
		if err != nil {
			t.Fatalf("%s: the builder must not refuse; the circuit must: %v", c.Name, err)
		}
		if solve(t, a) == nil {
			t.Fatalf("%s (%s): invalid message solved", c.Name, c.Reason)
		}
	}
	for _, r := range reasons {
		if !seen[r] {
			t.Errorf("no vector for %s", r)
		}
	}
}

func TestPublicInputsMatchTheVectors(t *testing.T) {
	for _, c := range vectors(t).Valid {
		chain := c.Chain()
		for i := range c.Messages {
			got, err := witness.Public(chain, i)
			if err != nil {
				t.Fatal(err)
			}
			for k := 0; k < circuit.NumPublic; k++ {
				if c.Public[i][k] == "" {
					continue // the state commitments are Poseidon2 values the Rust side does not compute; TestLinksChain and the solver cover them
				}
				if got[k].String() != c.Public[i][k] {
					t.Fatalf("%s/%d input %d: got %s want %s", c.Name, i, k, got[k], c.Public[i][k])
				}
			}
		}
	}
}

func TestLinksChain(t *testing.T) {
	for _, c := range vectors(t).Valid {
		chain := c.Chain()
		for i := 1; i < len(c.Messages); i++ {
			prev, _ := witness.Public(chain, i-1)
			cur, _ := witness.Public(chain, i)
			if cur[3].Cmp(prev[4]) != 0 {
				t.Fatalf("%s/%d: s_in is not the previous s_out", c.Name, i)
			}
		}
	}
}
