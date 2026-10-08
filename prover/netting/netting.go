// Package netting is the circuit of a private circular netting: one proof that the cancellations among up to
// eight participants are a circulation, committed to by per-participant Poseidon digests of the tab slots.
package netting

import (
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/math/bits"

	"github.com/DavidZapataOh/buckspay/prover/poseidon"
)

const (
	// MaxParticipants is the largest group of a netting.
	MaxParticipants = 8
	// Slots is the number of participant pairs, one tab slot each.
	Slots = MaxParticipants * (MaxParticipants - 1) / 2
	// NumPublic is the number of public inputs: session field, participants, total and root.
	NumPublic = 4
	// AmountBits is the width every amount is ranged to.
	AmountBits = 64
	// SeqDirBits is the width of 2·seq + dir.
	SeqDirBits = 33
)

// Slot is one pair of participants. SeqDir is 2·seq + dir: dir 0 means the lower index owes the higher one.
// An absent tab is the empty slot, all five fields zero.
type Slot struct{ Salt, Tab, SeqDir, Debt, Cancel frontend.Variable }

// Netting is the witness and the public statement, in the order the on-chain verifier builds its inputs.
type Netting struct {
	Session, Participants, Total, Root frontend.Variable `gnark:",public"`
	Slots                              [Slots]Slot
	// Active holds the activity flags of participants 2..7; participants 0 and 1 are always active.
	Active [MaxParticipants - 2]frontend.Variable
}

// PublicNames lists the public inputs in verifier order.
func PublicNames() []string { return []string{"Session", "Participants", "Total", "Root"} }

// SlotIndex is the position of the pair (i, j), i < j, in lexicographic order. It panics on any other pair.
func SlotIndex(i, j int) int {
	if i < 0 || i >= j || j >= MaxParticipants {
		panic("netting: slot of an invalid pair")
	}
	return i*(2*MaxParticipants-1-i)/2 + (j - i - 1)
}

// Ends is the inverse of SlotIndex.
func Ends(s int) (i, j int) {
	if s < 0 || s >= Slots {
		panic("netting: slot out of range")
	}
	for i = 0; i < MaxParticipants-1; i++ {
		if s < SlotIndex(i, MaxParticipants-1)+1 {
			return i, i + 1 + s - SlotIndex(i, i+1)
		}
	}
	panic("unreachable")
}

// Define constrains the netting.
func (c *Netting) Define(api frontend.API) error {
	active := [MaxParticipants]frontend.Variable{1, 1}
	copy(active[2:], c.Active[:])
	sum := frontend.Variable(2)
	for p := 2; p < MaxParticipants; p++ {
		api.AssertIsBoolean(active[p])
		sum = api.Add(sum, active[p])
		if p+1 < MaxParticipants {
			api.AssertIsEqual(api.Mul(active[p+1], api.Sub(1, active[p])), 0)
		}
	}
	api.AssertIsEqual(sum, c.Participants)

	var leaves [Slots]frontend.Variable
	var net [MaxParticipants]frontend.Variable
	for p := range net {
		net[p] = frontend.Variable(0)
	}
	cancels := frontend.Variable(0)
	for s := range c.Slots {
		x := c.Slots[s]
		i, j := Ends(s)
		bits.ToBinary(api, x.Cancel, bits.WithNbDigits(AmountBits))
		bits.ToBinary(api, api.Sub(x.Debt, x.Cancel), bits.WithNbDigits(AmountBits))
		dir := bits.ToBinary(api, x.SeqDir, bits.WithNbDigits(SeqDirBits))[0]
		signed := api.Sub(x.Cancel, api.Mul(2, api.Mul(x.Cancel, dir)))
		if j >= 2 {
			api.AssertIsEqual(api.Mul(x.Debt, api.Sub(1, active[j])), 0)
		}
		net[i] = api.Add(net[i], signed)
		net[j] = api.Sub(net[j], signed)
		cancels = api.Add(cancels, x.Cancel)

		l := poseidon.Hash(api, x.Salt, x.Tab)
		l = poseidon.Hash(api, l, x.SeqDir)
		l = poseidon.Hash(api, l, x.Debt)
		leaves[s] = poseidon.Hash(api, l, x.Cancel)
	}
	for p := range net {
		api.AssertIsEqual(net[p], 0)
	}
	api.AssertIsEqual(cancels, c.Total)
	bits.ToBinary(api, c.Total, bits.WithNbDigits(AmountBits))

	var root frontend.Variable
	for p := 0; p < MaxParticipants; p++ {
		d := poseidon.Hash(api, c.Session, p)
		for q := 0; q < MaxParticipants; q++ {
			if q != p {
				d = poseidon.Hash(api, d, leaves[SlotIndex(min(p, q), max(p, q))])
			}
		}
		if p == 0 {
			root = d
		} else {
			root = poseidon.Hash(api, root, d)
		}
	}
	api.AssertIsEqual(root, c.Root)
	return nil
}
