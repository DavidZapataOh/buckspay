package netting

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math/bits"

	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark/frontend"
)

// SlotWireLen is the size of one slot on the witness wire: present u8, salt 32, tab 32, seq u32 LE, dir u8, debt
// u64 LE, cancel u64 LE.
const SlotWireLen = 86

// ErrWitness wraps every refusal of a witness, so that callers can tell a bad witness from a failure of the prover.
var ErrWitness = errors.New("invalid netting witness")

func refuse(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrWitness, fmt.Sprintf(format, a...))
}

// WitnessSlot is one pair of participants. Salt is the canonical big-endian field element SaltFor returns and Tab
// the raw tab id; an absent slot has Present false and every other field zero.
type WitnessSlot struct {
	Present   bool
	Salt, Tab [32]byte
	Seq       uint32
	Dir       uint8
	Debt      uint64
	Cancel    uint64
}

// EncodeWitness is the wire the app writes: the statement body followed by the 28 slots.
func EncodeWitness(s Statement, slots [Slots]WitnessSlot) []byte {
	b := s.Encode()
	for _, w := range slots {
		present := byte(0)
		if w.Present {
			present = 1
		}
		b = append(b, present)
		b = append(b, w.Salt[:]...)
		b = append(b, w.Tab[:]...)
		b = binary.LittleEndian.AppendUint32(b, w.Seq)
		b = append(b, w.Dir)
		b = binary.LittleEndian.AppendUint64(b, w.Debt)
		b = binary.LittleEndian.AppendUint64(b, w.Cancel)
	}
	return b
}

// DecodeWitness reads EncodeWitness. It refuses what cannot be a slot (flags other than 0 and 1, an absent slot
// with data); Assign refuses what cannot be proved.
func DecodeWitness(b []byte) (Statement, [Slots]WitnessSlot, error) {
	var slots [Slots]WitnessSlot
	if len(b) < statementFixed {
		return Statement{}, slots, refuse("witness too short")
	}
	n := int(b[66])
	if n < 2 || n > MaxParticipants {
		return Statement{}, slots, refuse("%d participants", n)
	}
	body := statementFixed + 32*n
	if len(b) != body+Slots*SlotWireLen {
		return Statement{}, slots, refuse("witness of %d bytes, want %d", len(b), body+Slots*SlotWireLen)
	}
	st, err := DecodeStatement(b[:body])
	if err != nil {
		return Statement{}, slots, refuse("%v", err)
	}
	for s := range slots {
		raw := b[body+s*SlotWireLen : body+(s+1)*SlotWireLen]
		if raw[0] > 1 {
			return Statement{}, slots, refuse("slot %d: present flag %d", s, raw[0])
		}
		if raw[0] == 0 {
			for _, c := range raw {
				if c != 0 {
					return Statement{}, slots, refuse("slot %d: absent with data", s)
				}
			}
			continue
		}
		w := &slots[s]
		w.Present = true
		copy(w.Salt[:], raw[1:33])
		copy(w.Tab[:], raw[33:65])
		w.Seq = binary.LittleEndian.Uint32(raw[65:69])
		w.Dir = raw[69]
		w.Debt = binary.LittleEndian.Uint64(raw[70:78])
		w.Cancel = binary.LittleEndian.Uint64(raw[78:86])
		if w.Dir > 1 {
			return Statement{}, slots, refuse("slot %d: direction %d", s, w.Dir)
		}
	}
	return st, slots, nil
}

// Assign checks a witness natively and builds its assignment. It refuses before any proving work: a salt that is
// not canonical, an absent slot with data, a direction above one, a debt on a slot that touches a participant who
// did not sign, a cancel above its debt, cancels that overflow or differ from the total, a participant whose
// cancelled credit differs from its cancelled debt, and a computed root that is not the one in the statement.
func Assign(s Statement, slots [Slots]WitnessSlot) (*Netting, error) {
	if err := s.check(); err != nil {
		return nil, refuse("%v", err)
	}
	n := int(s.Participants)
	var sum uint64
	var credit, debit [MaxParticipants]uint64
	for k, w := range slots {
		if _, err := Leaf(w); err != nil {
			return nil, refuse("slot %d: %v", k, err)
		}
		if !w.Present {
			continue
		}
		i, j := Ends(k)
		if j >= n {
			return nil, refuse("slot %d touches participant %d of %d", k, j, n)
		}
		if w.Cancel > w.Debt {
			return nil, refuse("slot %d: cancel above debt", k)
		}
		var carry uint64
		if sum, carry = bits.Add64(sum, w.Cancel, 0); carry != 0 {
			return nil, refuse("cancels overflow 2^64")
		}
		debtor, creditor := i, j
		if w.Dir == 1 {
			debtor, creditor = j, i
		}
		debit[debtor] += w.Cancel
		credit[creditor] += w.Cancel
	}
	if sum != s.Total {
		return nil, refuse("cancels sum to %d, total is %d", sum, s.Total)
	}
	for p := 0; p < n; p++ {
		if debit[p] != credit[p] {
			return nil, refuse("participant %d: cancelled credit differs from cancelled debt", p)
		}
	}
	var d [MaxParticipants]fr.Element
	for p := range d {
		var err error
		if d[p], err = Digest(SessionField(s), p, &slots); err != nil {
			return nil, refuse("%v", err)
		}
	}
	if bytesOf(RootOf(d)) != s.Root {
		return nil, refuse("computed root differs from the statement's")
	}
	return witnessOf(s, &slots), nil
}

// witnessOf builds the assignment of a checked witness; every field is a canonical field element.
func witnessOf(s Statement, slots *[Slots]WitnessSlot) *Netting {
	c := &Netting{Participants: uint64(s.Participants), Total: s.Total}
	c.Session = fieldOf(SessionField(s))
	c.Root = fieldOf(s.Root)
	for p := 2; p < MaxParticipants; p++ {
		c.Active[p-2] = 0
		if p < int(s.Participants) {
			c.Active[p-2] = 1
		}
	}
	for k, w := range slots {
		c.Slots[k] = Slot{Salt: 0, Tab: 0, SeqDir: 0, Debt: 0, Cancel: 0}
		if !w.Present {
			continue
		}
		c.Slots[k] = Slot{
			Salt:   fieldOf(w.Salt),
			Tab:    TabField(w.Tab),
			SeqDir: uint64(w.Seq)*2 + uint64(w.Dir),
			Debt:   w.Debt,
			Cancel: w.Cancel,
		}
	}
	return c
}

func fieldOf(b [32]byte) frontend.Variable {
	var e fr.Element
	e.SetBytes(b[:])
	return e
}
