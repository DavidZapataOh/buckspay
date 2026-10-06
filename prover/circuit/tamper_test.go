package circuit_test

import (
	"crypto/elliptic"
	"crypto/rand"
	"math/big"
	"testing"

	"github.com/consensys/gnark/constraint/solver"
	"github.com/consensys/gnark/std/math/emulated"

	"github.com/DavidZapataOh/buckspay/prover/circuit"
	"github.com/DavidZapataOh/buckspay/prover/witness"
)

func plus(v any, d *big.Int) any { return new(big.Int).Add(v.(*big.Int), d) }

// These malformations cannot be written as a protocol message: they live in the assignment the prover controls.
func TestAssignmentTamperingFails(t *testing.T) {
	v := vectors(t)
	branch := v.ByName("issue_plus_2_branch").Chain()
	single := v.ByName("issue_plus_2_single").Chain()
	one := big.NewInt(1)
	cases := []struct {
		name  string
		chain *witness.Chain
		i     int
		edit  func(a *circuit.Message)
	}{
		{"ctrl_above_three_bits", branch, 1, func(a *circuit.Message) { a.Ctrl = plus(a.Ctrl, big.NewInt(8)) }},
		{"issue_and_last_both_set", branch, 0, func(a *circuit.Message) { a.Ctrl = big.NewInt(circuit.CtrlIssue | circuit.CtrlLast) }},
		{"next_bit_on_last", branch, 2, func(a *circuit.Message) { a.Ctrl = big.NewInt(circuit.CtrlLast | circuit.CtrlNext1) }},
		{"next_bit_on_single_output_spend", single, 1, func(a *circuit.Message) { a.Ctrl = plus(a.Ctrl, big.NewInt(circuit.CtrlNext1)) }},
		{"issue_marked_as_spend", branch, 0, func(a *circuit.Message) { a.Ctrl = plus(a.Ctrl, big.NewInt(-circuit.CtrlIssue)) }},
		{"spend_marked_as_issue", branch, 1, func(a *circuit.Message) { a.Ctrl = plus(a.Ctrl, big.NewInt(circuit.CtrlIssue)) }},
		{"amt_out_of_range", branch, 2, func(a *circuit.Message) { a.Amt = plus(a.Amt, new(big.Int).Lsh(one, 96)) }},
		{"e_limb_over_128_bits", branch, 1, func(a *circuit.Message) {
			a.E[1] = plus(a.E[1], new(big.Int).Lsh(one, 128)) // the same integer e_hi·2^128 + e_lo
			a.E[0] = plus(a.E[0], big.NewInt(-1))
		}},
	}
	for _, c := range cases {
		a, err := witness.Assign(c.chain, c.i)
		if err != nil {
			t.Fatal(err)
		}
		c.edit(a)
		if solve(t, a) == nil {
			t.Errorf("%s: tampered assignment solved", c.name)
		}
	}
}

// otherRoot runs the real decompression hint and returns p − y, the root of the other parity.
func otherRoot(_ *big.Int, in, out []*big.Int) error {
	return emulated.UnwrapHint(in, out, func(p *big.Int, in, out []*big.Int) error {
		if err := circuit.DecompressYField(p, in, out); err != nil {
			return err
		}
		out[0].Sub(p, out[0])
		return nil
	})
}

func TestDecompressionHintCannotFlipParity(t *testing.T) {
	a, err := witness.Assign(vectors(t).ByName("issue_plus_2_branch").Chain(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := solve(t, a); err != nil {
		t.Fatalf("the honest witness must solve: %v", err)
	}
	if solve(t, a, solver.OverrideHint(solver.GetHintID(circuit.DecompressY), otherRoot)) == nil {
		t.Fatal("a hint returning p − y solved: the parity bit is not enforced")
	}
}

// zeroRoot is a hint a malicious prover would use for a key that is not on the curve: y = 0.
func zeroRoot(_ *big.Int, in, out []*big.Int) error {
	return emulated.UnwrapHint(in, out, func(_ *big.Int, _, out []*big.Int) error {
		out[0].SetUint64(0)
		return nil
	})
}

// forge signs e under the key (1, 0), a point of order 2 on the curve y² = x³ − 3x + 2: with an
// even u2 the verification equation collapses to [u1]G, whose x coordinate anyone can compute.
func forge(t *testing.T, e *big.Int) (r, s *big.Int) {
	t.Helper()
	curve := elliptic.P256()
	n := curve.Params().N
	em := new(big.Int).Mod(e, n)
	for {
		k, err := rand.Int(rand.Reader, n)
		if err != nil || k.Sign() == 0 {
			t.Fatal(err)
		}
		x, _ := curve.ScalarBaseMult(k.FillBytes(make([]byte, 32)))
		r = new(big.Int).Mod(x, n)
		s = new(big.Int).Mul(em, new(big.Int).ModInverse(k, n))
		s.Mod(s, n)
		u2 := new(big.Int).Mul(r, new(big.Int).ModInverse(s, n))
		u2.Mod(u2, n)
		if r.Sign() != 0 && s.Sign() != 0 && u2.Bit(0) == 0 && s.Cmp(new(big.Int).Rsh(n, 1)) <= 0 {
			return r, s
		}
	}
}

// A signer key that is not on the curve must be refused even when the prover supplies y = 0 and a
// signature forged for a point of small order.
func TestOffCurveSignerIsRefused(t *testing.T) {
	chain := vectors(t).ByName("issue_plus_2_single").Chain()
	var offCurve [33]byte
	offCurve[0], offCurve[32] = 2, 1
	copy(chain.Messages[1].Body[22:55], offCurve[:])
	chain.Openings[2].Owner = offCurve
	pub, err := witness.Public(chain, 2)
	if err != nil {
		t.Fatal(err)
	}
	e := new(big.Int).Add(new(big.Int).Lsh(pub[0], 128), pub[1])
	chain.Messages[2].R, chain.Messages[2].S = forge(t, e)
	a, err := witness.Assign(chain, 2)
	if err != nil {
		t.Fatal(err)
	}
	if solve(t, a) == nil {
		t.Fatal("the honest hint cannot give y = 0 for this key, yet the message solved")
	}
	if solve(t, a, solver.OverrideHint(solver.GetHintID(circuit.DecompressY), zeroRoot)) == nil {
		t.Fatal("a signature forged for an off-curve key of order 2 was accepted")
	}
}
