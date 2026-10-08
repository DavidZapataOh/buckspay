package netting

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"math/big"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/test"

	"github.com/DavidZapataOh/buckspay/prover/poseidon"
)

// The proving key's domain is the next power of two above the constraint count. minConstraints is the count
// with every rule in place, written in the commit that first makes this test pass: dropping any rule lowers the
// count below it. Both bounds change only in a commit that records new measurements.
const (
	margin         = 2_048
	maxConstraints = 1<<16 - margin
	minConstraints = 48_662 // the count with every rule in place
)

var field = ecc.BN254.ScalarField()

type debt struct {
	from, to       int
	amount, cancel uint64
}

func label(name string, parts ...int) (out [32]byte) {
	b := []byte("buckspay/netting-test/" + name)
	for _, p := range parts {
		b = binary.LittleEndian.AppendUint32(b, uint32(p))
	}
	return sha256.Sum256(b)
}

func ephemeralKey(p int) (k [32]byte) {
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(0x40 + p)
	}
	copy(k[:], ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey))
	return k
}

// build is an honest netting among n participants: every debt on its own pair, the root from the native code.
func build(t testing.TB, n int, debts []debt) (Statement, [Slots]WitnessSlot) {
	t.Helper()
	session := label("session", n, len(debts))
	var slots [Slots]WitnessSlot
	var total uint64
	for k, d := range debts {
		i, j, dir := d.from, d.to, uint8(0)
		if i > j {
			i, j, dir = j, i, 1
		}
		s := SlotIndex(i, j)
		if slots[s].Present {
			t.Fatalf("two debts on slot %d", s)
		}
		slots[s] = WitnessSlot{Present: true, Salt: SaltFor(label("secret", i, j), session), Tab: label("tab", i, j),
			Seq: uint32(7 + k), Dir: dir, Debt: d.amount, Cancel: d.cancel}
		total += d.cancel
	}
	st := Statement{Session: session, Mint: [32]byte{0x4d}, Participants: uint8(n), Total: total, Expires: 4_000_000_000}
	for p := 0; p < n; p++ {
		st.Ephemeral = append(st.Ephemeral, ephemeralKey(p))
	}
	var d [MaxParticipants]fr.Element
	for p := range d {
		var err error
		if d[p], err = Digest(SessionField(st), p, &slots); err != nil {
			t.Fatal(err)
		}
	}
	st.Root = rootBytes(d)
	return st, slots
}

// rootBytes is the big-endian encoding of the root of the digests.
func rootBytes(d [MaxParticipants]fr.Element) [32]byte {
	root := RootOf(d)
	return root.Bytes()
}

func assigned(t testing.TB, st Statement, slots [Slots]WitnessSlot) *Netting {
	t.Helper()
	c, err := Assign(st, slots)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

const third = (1<<64 - 1) / 3 // 2^64 − 1 is divisible by 3

var (
	debts2 = []debt{{0, 1, 10, 0}}
	debts5 = []debt{{0, 1, 10, 5}, {1, 2, 7, 5}, {2, 0, 5, 5}, {3, 4, 9, 0}, {1, 3, 4, 0}}
	debts8 = []debt{
		{0, 1, 1<<64 - 1, 1 << 61}, {1, 5, 1 << 63, 1 << 61}, {5, 7, 1<<63 + 5, 1 << 61}, {7, 0, 3 << 62, 1 << 61},
		{2, 3, 3, 3}, {3, 4, 3, 3}, {4, 2, 3, 3}, {6, 2, 1, 0},
	}
	debtsMax  = []debt{{0, 1, third, third}, {1, 2, third, third}, {2, 0, third, third}}
	debtsOnes = []debt{{0, 1, 1, 1}, {1, 2, 1, 1}, {2, 0, 1, 1}}
)

func honest(t testing.TB, n int, debts []debt) *Netting {
	st, slots := build(t, n, debts)
	return assigned(t, st, slots)
}

func solved(c *Netting) error { return test.IsSolved(&Netting{}, c, field) }

func fe(v frontend.Variable) fr.Element {
	var e fr.Element
	if _, err := e.SetInterface(v); err != nil {
		panic(err)
	}
	return e
}

func plus(v frontend.Variable, d *big.Int) frontend.Variable {
	e := fe(v)
	var x fr.Element
	x.SetBigInt(d)
	e.Add(&e, &x)
	return e
}

func pow2(k uint) *big.Int { return new(big.Int).Lsh(big.NewInt(1), k) }

// reroot recomputes Root from the slots as assigned, so a tamper breaks only the rule it targets.
func reroot(c *Netting) {
	c.Root = rootOf(c, nil)
}

// rootOf hashes the assigned slots; order, if given, is the order the digests are chained in.
func rootOf(c *Netting, order []int) fr.Element {
	var leaves [Slots]fr.Element
	for s, x := range c.Slots {
		l := poseidon.Native(fe(x.Salt), fe(x.Tab))
		l = poseidon.Native(l, fe(x.SeqDir))
		l = poseidon.Native(l, fe(x.Debt))
		leaves[s] = poseidon.Native(l, fe(x.Cancel))
	}
	if order == nil {
		order = []int{0, 1, 2, 3, 4, 5, 6, 7}
	}
	var root fr.Element
	for k, p := range order {
		d := poseidon.Native(fe(c.Session), fe(p))
		for q := 0; q < MaxParticipants; q++ {
			if q != p {
				d = poseidon.Native(d, leaves[SlotIndex(min(p, q), max(p, q))])
			}
		}
		if k == 0 {
			root = d
		} else {
			root = poseidon.Native(root, d)
		}
	}
	return root
}

func TestHonestWitnessesSolve(t *testing.T) {
	for name, c := range map[string]struct {
		n     int
		debts []debt
	}{"n2": {2, debts2}, "n5": {5, debts5}, "n8": {8, debts8}, "total_is_2_64_minus_1": {3, debtsMax}} {
		t.Run(name, func(t *testing.T) {
			if err := solved(honest(t, c.n, c.debts)); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestEveryTamperFails(t *testing.T) {
	r := field
	s01, s12, s34, s04 := SlotIndex(0, 1), SlotIndex(1, 2), SlotIndex(3, 4), SlotIndex(0, 4)
	cases := map[string]struct {
		base  func(*testing.T) *Netting
		alter func(*Netting)
	}{
		// C7: a participant's net changes by one unit.
		"net_changes_by_one": {nil, func(c *Netting) { c.Slots[s01].Cancel = 6; c.Total = 16; reroot(c) }},
		// C2: more cancelled than owed.
		"cancel_above_debt": {nil, func(c *Netting) { c.Slots[s12].Debt = 4; reroot(c) }},
		// C1 alone: cancel −1 with the direction flipped keeps conservation, total and C2.
		"negative_cancel_flips_direction": {func(t *testing.T) *Netting { return honest(t, 3, debtsOnes) }, func(c *Netting) {
			c.Slots[s01].SeqDir = plus(c.Slots[s01].SeqDir, big.NewInt(1))
			c.Slots[s01].Cancel = new(big.Int).Sub(r, big.NewInt(1))
			c.Slots[s01].Debt = 0
			c.Total = 1
			reroot(c)
		}},
		// C2 alone: Debt − Cancel = 2^64.
		"remainder_reaches_2_64": {nil, func(c *Netting) { c.Slots[s34].Debt = pow2(64); reroot(c) }},
		// C1 and C8: cancels of 2^64 around a cycle.
		"cancel_reaches_2_64": {func(t *testing.T) *Netting { return honest(t, 3, debtsOnes) }, func(c *Netting) {
			for _, s := range []int{SlotIndex(0, 1), SlotIndex(1, 2), SlotIndex(0, 2)} {
				c.Slots[s].Debt, c.Slots[s].Cancel = pow2(64), pow2(64)
			}
			c.Total = new(big.Int).Mul(big.NewInt(3), pow2(64))
			reroot(c)
		}},
		// C8 alone: every cancel in range, their sum is not.
		"total_reaches_2_64": {func(t *testing.T) *Netting {
			return honest(t, 3, []debt{{0, 1, 1 << 63, 0}, {1, 2, 1 << 63, 0}, {2, 0, 1 << 63, 0}})
		}, func(c *Netting) {
			for _, s := range []int{SlotIndex(0, 1), SlotIndex(1, 2), SlotIndex(0, 2)} {
				c.Slots[s].Cancel = pow2(63)
			}
			c.Total = new(big.Int).Mul(big.NewInt(3), pow2(63))
			reroot(c)
		}},
		"total_not_the_sum": {nil, func(c *Netting) { c.Total = 16 }},
		// C3: seq above 32 bits.
		"seqdir_reaches_2_33": {nil, func(c *Netting) { c.Slots[s34].SeqDir = pow2(33); reroot(c) }},
		// C6: a debt that involves someone who did not sign.
		"debt_on_slot_of_inactive_participant": {nil, func(c *Netting) {
			c.Slots[SlotIndex(0, 6)] = Slot{Salt: 1, Tab: 2, SeqDir: 18, Debt: 3, Cancel: 0}
			reroot(c)
		}},
		"cycle_among_inactive_participants": {nil, func(c *Netting) {
			for _, p := range [][2]int{{5, 6}, {6, 7}, {5, 7}} {
				dir := 0
				if p == [2]int{5, 7} {
					dir = 1
				}
				c.Slots[SlotIndex(p[0], p[1])] = Slot{Salt: 1, Tab: 2, SeqDir: 20 + dir, Debt: 2, Cancel: 2}
			}
			c.Total = 21
			reroot(c)
		}},
		"participants_lowered_below_a_debtor": {nil, func(c *Netting) { c.Participants = 4; c.Active[2] = 0 }},
		// C5: flags with a hole make participant 5 active while 4 is not; 4's tab moved to 5.
		"active_flags_with_a_hole": {nil, func(c *Netting) {
			c.Slots[SlotIndex(3, 5)], c.Slots[s34] = c.Slots[s34], Slot{0, 0, 0, 0, 0}
			c.Active = [MaxParticipants - 2]frontend.Variable{1, 1, 0, 1, 0, 0}
			reroot(c)
		}},
		// C9-C11: what a member checks in its own digest.
		"changed_amount":                 {nil, func(c *Netting) { c.Slots[s01].Debt = 11 }},
		"changed_salt":                   {nil, func(c *Netting) { c.Slots[s01].Salt = plus(c.Slots[s01].Salt, big.NewInt(1)) }},
		"older_base_seq":                 {nil, func(c *Netting) { c.Slots[s01].SeqDir = plus(c.Slots[s01].SeqDir, big.NewInt(-2)) }},
		"direction_flipped":              {nil, func(c *Netting) { c.Slots[s34].SeqDir = plus(c.Slots[s34].SeqDir, big.NewInt(1)) }},
		"slot_moved_to_other_pair":       {nil, func(c *Netting) { c.Slots[s04], c.Slots[s34] = c.Slots[s34], Slot{0, 0, 0, 0, 0} }},
		"digests_chained_in_other_order": {nil, func(c *Netting) { c.Root = rootOf(c, []int{1, 0, 2, 3, 4, 5, 6, 7}) }},
		"root_not_from_slots":            {nil, func(c *Netting) { c.Root = plus(c.Root, big.NewInt(1)) }},
		"slots_of_another_session":       {nil, func(c *Netting) { c.Session = plus(c.Session, big.NewInt(1)) }},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			var w *Netting
			if tc.base != nil {
				w = tc.base(t)
			} else {
				w = honest(t, 5, debts5)
			}
			if err := solved(w); err != nil {
				t.Fatalf("the base does not solve: %v", err)
			}
			tc.alter(w)
			if solved(w) == nil {
				t.Fatal("a tampered netting was accepted")
			}
		})
	}
}

func TestParticipantsOutsideTwoToEight(t *testing.T) {
	for _, n := range []int{0, 1, 9, 10} {
		w := honest(t, 2, debts2)
		if n > 2 {
			w = honest(t, 8, debts8)
		}
		w.Participants = n // the flags stay those of the honest n: no assignment of them sums to n
		if solved(w) == nil {
			t.Fatalf("participants = %d accepted", n)
		}
	}
}

func TestPublicInputOrder(t *testing.T) {
	st, slots := build(t, 5, debts5)
	pub, err := frontend.NewWitness(assigned(t, st, slots), field, frontend.PublicOnly())
	if err != nil {
		t.Fatal(err)
	}
	vec := pub.Vector().(fr.Vector)
	want := st.Public()
	if len(vec) != NumPublic {
		t.Fatalf("%d public inputs", len(vec))
	}
	for i := range want {
		if vec[i].Bytes() != want[i] {
			t.Fatalf("public %d (%s) is not the verifier's", i, PublicNames()[i])
		}
	}
}

func compiled(t testing.TB) constraint.ConstraintSystem {
	t.Helper()
	ccs, err := frontend.Compile(field, r1cs.NewBuilder, &Netting{})
	if err != nil {
		t.Fatal(err)
	}
	return ccs
}

func TestConstraintBudget(t *testing.T) {
	n := compiled(t).GetNbConstraints()
	t.Logf("constraints=%d", n)
	if n < minConstraints || n > maxConstraints || minConstraints == 0 {
		t.Fatalf("%d constraints outside [%d, %d]", n, minConstraints, maxConstraints)
	}
}

func TestProofIsBoundToEveryPublicInput(t *testing.T) {
	ccs := compiled(t)
	pk, vk, err := groth16.Setup(ccs)
	if err != nil {
		t.Fatal(err)
	}
	st, slots := build(t, 5, debts5)
	full, _ := frontend.NewWitness(assigned(t, st, slots), field)
	proof, err := groth16.Prove(ccs, pk, full)
	if err != nil {
		t.Fatal(err)
	}
	pub, _ := full.Public()
	if err := groth16.Verify(proof, vk, pub); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < NumPublic; i++ {
		alt := assigned(t, st, slots)
		v := []*frontend.Variable{&alt.Session, &alt.Participants, &alt.Total, &alt.Root}[i]
		*v = plus(*v, big.NewInt(1))
		w, _ := frontend.NewWitness(alt, field, frontend.PublicOnly())
		if groth16.Verify(proof, vk, w) == nil {
			t.Fatalf("the proof verifies with public %d changed", i)
		}
	}
}

// The session field binds every statement byte the other public inputs do not (ARCH v3 §3.2): a proof cannot be
// moved to another mint, expiry or key list.
func TestMintExpiresAndKeysReachThePublicInputs(t *testing.T) {
	st, _ := build(t, 5, debts5)
	for name, alter := range map[string]func(*Statement){
		"mint":    func(s *Statement) { s.Mint[31] ^= 1 },
		"expires": func(s *Statement) { s.Expires++ },
		"key": func(s *Statement) {
			s.Ephemeral = append([][32]byte{}, s.Ephemeral...)
			s.Ephemeral[4] = ephemeralKey(9)
		},
		"session": func(s *Statement) { s.Session[0] ^= 1 },
	} {
		other := st
		alter(&other)
		if other.Public()[0] == st.Public()[0] {
			t.Fatalf("%s does not change the session field", name)
		}
	}
}
