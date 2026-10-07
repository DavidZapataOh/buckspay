package claim

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math/big"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/test"
)

// The FFT domain of the proving key is the next power of two above the constraint count. Both
// bounds change only in a commit that records new measurements, and no check is removed to fit.
const (
	margin         = 8_192
	maxConstraints = 1<<19 - margin
	minConstraints = 5_975 // the count with every check in place
)

var field = ecc.BN254.ScalarField()

func be32(n uint64, salt string) [32]byte {
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], n)
	h := sha256.Sum256(append([]byte("buckspay/claim-test/"+salt), b[:]...))
	h[0] &= 0x1f
	return h
}

type opts struct {
	leaf, exp, leaves int
	nullifier         *[32]byte
}

func inputs(o opts) Inputs {
	return Inputs{
		Nullifier: be32(uint64(o.leaf), "nullifier"), Trapdoor: be32(uint64(o.leaf), "trapdoor"),
		Exp: uint8(o.exp), Scope: be32(1, "scope"), Recipient: be32(2, "recipient"),
		MaxFee: big.NewInt(900_000), LeafIndex: o.leaf,
	}
}

func buildTree(t testing.TB, o opts, replace map[int]Inputs) *Tree {
	t.Helper()
	tree := &Tree{}
	for i := 0; i < o.leaves; i++ {
		in := inputs(opts{leaf: i, exp: (i + 1) % 8})
		if r, ok := replace[i]; ok {
			in = r
		}
		n, err := FromCanonical(in.Nullifier)
		if err != nil {
			t.Fatal(err)
		}
		d, err := FromCanonical(in.Trapdoor)
		if err != nil {
			t.Fatal(err)
		}
		tree.Leaves = append(tree.Leaves, Leaf(Inner(n, d), in.Exp))
	}
	return tree
}

func fixture(t testing.TB, o opts) *Claim {
	t.Helper()
	in := inputs(o)
	if o.nullifier != nil {
		in.Nullifier = *o.nullifier
	}
	tree := buildTree(t, o, map[int]Inputs{o.leaf: in})
	c, err := Assign(tree, in)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func plus(v frontend.Variable, d uint64) frontend.Variable {
	var e fr.Element
	e.SetInterface(v)
	e.Add(&e, new(fr.Element).SetUint64(d))
	return e
}

func solved(c *Claim) error { return test.IsSolved(&Claim{}, c, field) }

func TestValidClaimIsSolved(t *testing.T) {
	if err := solved(fixture(t, opts{leaf: 5, exp: 3, leaves: 9})); err != nil {
		t.Fatal(err)
	}
}

func TestEveryRejectionFails(t *testing.T) {
	zero := [32]byte{}
	rawExp8 := func(c *Claim) {
		in := inputs(opts{leaf: 5, exp: 7})
		n, _ := FromCanonical(in.Nullifier)
		d, _ := FromCanonical(in.Trapdoor)
		other := buildTree(t, opts{leaves: 9}, nil)
		other.Leaves[5] = Leaf(Inner(n, d), 8)
		c.Exp, c.Root = 8, other.Root()
	}
	cases := map[string]func(*Claim){
		"wrong_root":            func(c *Claim) { c.Root = plus(c.Root, 1) },
		"wrong_nullifier_hash":  func(c *Claim) { c.NullifierHash = plus(c.NullifierHash, 1) },
		"other_scope":           func(c *Claim) { c.Scope = plus(c.Scope, 1) },
		"other_exp":             func(c *Claim) { c.Exp = 4 },
		"exp_above_seven":       rawExp8,
		"path_bit_not_boolean":  func(c *Claim) { c.Bits[3] = 2 },
		"path_bit_flipped":      func(c *Claim) { c.Bits[0] = 1 - c.Bits[0].(uint64) },
		"path_sibling_altered":  func(c *Claim) { c.Path[7] = plus(c.Path[7], 1) },
		"recipient_hi_too_wide": func(c *Claim) { c.RecipientHi = new(big.Int).Lsh(big.NewInt(1), 128) },
		"recipient_lo_too_wide": func(c *Claim) { c.RecipientLo = new(big.Int).Lsh(big.NewInt(1), 128) },
		"max_fee_too_wide":      func(c *Claim) { c.MaxFee = new(big.Int).Lsh(big.NewInt(1), 128) },
	}
	for name, alter := range cases {
		t.Run(name, func(t *testing.T) {
			w := fixture(t, opts{leaf: 5, exp: 3, leaves: 9})
			alter(w)
			if solved(w) == nil {
				t.Fatal("an altered claim was accepted")
			}
		})
	}
	t.Run("zero_nullifier", func(t *testing.T) {
		if solved(fixture(t, opts{leaf: 5, leaves: 9, nullifier: &zero})) == nil {
			t.Fatal("a zero nullifier was accepted")
		}
	})
	t.Run("zero_trapdoor", func(t *testing.T) {
		in := inputs(opts{leaf: 5})
		in.Trapdoor = zero
		tree := buildTree(t, opts{leaves: 9}, map[int]Inputs{5: in})
		c, err := Assign(tree, in)
		if err != nil {
			t.Fatal(err)
		}
		if solved(c) == nil {
			t.Fatal("a zero trapdoor was accepted")
		}
	})
}

func TestEmptyLeafCannotBeOpened(t *testing.T) {
	tree := buildTree(t, opts{leaves: 9}, nil)
	siblings, pos, err := tree.Path(12)
	if err != nil {
		t.Fatal(err)
	}
	w := fixture(t, opts{leaf: 5, exp: 3, leaves: 9})
	w.Root = tree.Root()
	for k := 0; k < Depth; k++ {
		w.Path[k], w.Bits[k] = siblings[k], uint64(pos[k])
	}
	if solved(w) == nil {
		t.Fatal("a path to the empty leaf was opened")
	}
}

func TestEveryLeafOfATreeOpens(t *testing.T) {
	for i := 0; i < 9; i++ {
		if err := solved(fixture(t, opts{leaf: i, exp: (i + 1) % 8, leaves: 9})); err != nil {
			t.Fatalf("leaf %d: %v", i, err)
		}
	}
}

func TestPublicInputOrderIsTheVerifierOrder(t *testing.T) {
	ccs, err := frontend.Compile(field, r1cs.NewBuilder, &Claim{})
	if err != nil {
		t.Fatal(err)
	}
	want := PublicNames()
	if got := ccs.GetNbPublicVariables() - 1; got != NumPublic || len(want) != NumPublic {
		t.Fatalf("%d public inputs, want %d", got, NumPublic)
	}
	w := fixture(t, opts{leaf: 3, exp: 2, leaves: 9})
	pub, err := frontend.NewWitness(w, field, frontend.PublicOnly())
	if err != nil {
		t.Fatal(err)
	}
	got := pub.Vector().(fr.Vector)
	order := []frontend.Variable{w.Root, w.NullifierHash, w.Scope, w.RecipientHi, w.RecipientLo, w.Exp, w.MaxFee}
	for i, v := range order {
		var e fr.Element
		e.SetInterface(v)
		if !got[i].Equal(&e) {
			t.Fatalf("public input %d is not %s", i, want[i])
		}
	}
}

func TestConstraintBudget(t *testing.T) {
	ccs, err := frontend.Compile(field, r1cs.NewBuilder, &Claim{})
	if err != nil {
		t.Fatal(err)
	}
	n := ccs.GetNbConstraints()
	t.Logf("constraints=%d", n)
	if n > maxConstraints {
		t.Fatalf("constraint budget exceeded: %d > %d. Never remove or weaken a check to fit. Measure the next domain, record it, then raise maxConstraints to that domain minus the margin", n, maxConstraints)
	}
	if n < minConstraints {
		t.Fatalf("%d constraints, fewer than the reviewed %d: a check may have been removed; review the rules and the vectors before lowering minConstraints", n, minConstraints)
	}
}

func TestCanonicalForm(t *testing.T) {
	r := fr.Modulus()
	at := func(d int64) [32]byte {
		var b [32]byte
		new(big.Int).Add(r, big.NewInt(d)).FillBytes(b[:])
		return b
	}
	small := func(v int64) [32]byte {
		var b [32]byte
		big.NewInt(v).FillBytes(b[:])
		return b
	}
	for name, tc := range map[string]struct {
		in [32]byte
		ok bool
	}{"0": {small(0), true}, "1": {small(1), true}, "r-1": {at(-1), true}, "r": {at(0), false}, "r+1": {at(1), false}, "2^256-1": {[32]byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}, false}} {
		e, err := FromCanonical(tc.in)
		if tc.ok == (err != nil) || (!tc.ok && !errors.Is(err, ErrNonCanonical)) {
			t.Fatalf("%s: err=%v", name, err)
		}
		if tc.ok && Bytes32(e) != tc.in {
			t.Fatalf("%s does not round-trip", name)
		}
		for field, set := range map[string]func(*Inputs){
			"nullifier": func(i *Inputs) { i.Nullifier = tc.in },
			"trapdoor":  func(i *Inputs) { i.Trapdoor = tc.in },
			"scope":     func(i *Inputs) { i.Scope = tc.in },
		} {
			in := inputs(opts{leaf: 0})
			tree := buildTree(t, opts{leaves: 1}, nil)
			set(&in)
			// the tree does not hold these secrets; only the canonical check is under test
			_, err := Assign(tree, in)
			if tc.ok && errors.Is(err, ErrNonCanonical) {
				t.Fatalf("%s as %s refused: %v", name, field, err)
			}
			if !tc.ok && !errors.Is(err, ErrNonCanonical) {
				t.Fatalf("%s as %s was not refused as non-canonical: %v", name, field, err)
			}
		}
	}
}

func TestRecipientAndFeeChangeTheProofStatement(t *testing.T) {
	ccs, err := frontend.Compile(field, r1cs.NewBuilder, &Claim{})
	if err != nil {
		t.Fatal(err)
	}
	pk, vk, err := groth16.Setup(ccs)
	if err != nil {
		t.Fatal(err)
	}
	w := fixture(t, opts{leaf: 1, exp: 0, leaves: 2})
	full, err := frontend.NewWitness(w, field)
	if err != nil {
		t.Fatal(err)
	}
	proof, err := groth16.Prove(ccs, pk, full)
	if err != nil {
		t.Fatal(err)
	}
	verify := func(c *Claim) error {
		pub, err := frontend.NewWitness(c, field, frontend.PublicOnly())
		if err != nil {
			t.Fatal(err)
		}
		return groth16.Verify(proof, vk, pub)
	}
	if err := verify(w); err != nil {
		t.Fatal(err)
	}
	for name, alter := range map[string]func(*Claim){
		"recipient_hi": func(c *Claim) { c.RecipientHi = plus(c.RecipientHi, 1) },
		"recipient_lo": func(c *Claim) { c.RecipientLo = plus(c.RecipientLo, 1) },
		"max_fee":      func(c *Claim) { c.MaxFee = plus(c.MaxFee, 1) },
		"scope":        func(c *Claim) { c.Scope = plus(c.Scope, 1) },
		"exp":          func(c *Claim) { c.Exp = 1 },
		"root":         func(c *Claim) { c.Root = plus(c.Root, 1) },
		"nullifier":    func(c *Claim) { c.NullifierHash = plus(c.NullifierHash, 1) },
	} {
		other := *w
		alter(&other)
		if verify(&other) == nil {
			t.Fatalf("a proof verified with another %s", name)
		}
	}
}
