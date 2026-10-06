// Package witness builds the circuit assignment of one message from the history a phone holds,
// and the public inputs the program derives for it.
package witness

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"math/big"

	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr/poseidon2"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/math/emulated"
	"github.com/consensys/gnark/std/math/uints"

	"github.com/DavidZapataOh/buckspay/prover/circuit"
)

// Signed is a message as it travels: its body and the signature of the device that made it.
type Signed struct {
	Kind byte
	Body []byte
	R, S *big.Int
	Key  [33]byte
}

// Opening is what the holder knows of the output a message consumes.
type Opening struct {
	Owner   [33]byte
	Amount  uint64
	Caveats [27]byte
	Salt    [16]byte // salt of the message that created the output
	Index   uint8    // which of its outputs
}

// Override replaces public input Index of message At by its value plus Delta. It models a prover
// that claims a public input the message does not give.
type Override struct {
	At, Index int
	Delta     *big.Int
}

// Chain is what the settling phone holds: Openings[i] is the output message i consumes (unused for the issue).
type Chain struct {
	Domain   [32]byte
	Messages []Signed
	Openings []Opening
	Override *Override
}

var (
	two32  = new(big.Int).Lsh(big.NewInt(1), 32)
	two128 = new(big.Int).Lsh(big.NewInt(1), 128)
)

func sha(parts ...[]byte) [32]byte {
	h := sha256.New()
	for _, p := range parts {
		h.Write(p)
	}
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

// Content is the SHA-256 of the body of message i.
func Content(c *Chain, i int) [32]byte { return sha(c.Messages[i].Body) }

func outputID(id [32]byte, index uint8) [32]byte { return sha([]byte("BPO1"), id[:], []byte{index}) }

func scopeHash(owner [33]byte) [20]byte {
	h := sha([]byte("BPS1"), owner[:])
	var out [20]byte
	copy(out[:], h[:20])
	return out
}

func le(b []byte) *big.Int {
	r := make([]byte, len(b))
	for i := range b {
		r[len(b)-1-i] = b[i]
	}
	return new(big.Int).SetBytes(r)
}

func commit(owner [33]byte, amount, caveats *big.Int, holder [20]byte, blind *big.Int) *big.Int {
	h := poseidon2.NewMerkleDamgardHasher()
	hi := new(big.Int).SetBytes(owner[:17])
	lo := new(big.Int).SetBytes(owner[17:])
	for _, x := range []*big.Int{hi, lo, amount, caveats, new(big.Int).SetBytes(holder[:]), blind} {
		var e fr.Element
		e.SetBigInt(x)
		b := e.Bytes()
		h.Write(b[:])
	}
	return new(big.Int).SetBytes(h.Sum(nil))
}

// body holds the fields of a message body at the offsets of its kind.
type body struct {
	kind    byte
	lockSeq uint32
	salt    [16]byte
	owner0  [33]byte
	cav0    [27]byte
	amt0    uint64
}

func parse(m Signed, in Opening) (body, error) {
	var p body
	b := m.Body
	switch {
	case len(b) == circuit.IssueBodyLen && b[1] == circuit.KindIssue:
		p.kind = circuit.KindIssue
		p.lockSeq = binary.LittleEndian.Uint32(b[67:71])
		copy(p.salt[:], b[79:95])
		copy(p.owner0[:], b[95:128])
		p.amt0 = binary.LittleEndian.Uint64(b[128:136])
		copy(p.cav0[:], b[136:163])
	case len(b) == circuit.Spend1BodyLen && b[1] == circuit.KindSpend1:
		p.kind = circuit.KindSpend1
		p.lockSeq = binary.LittleEndian.Uint32(b[2:6])
		copy(p.salt[:], b[6:22])
		copy(p.owner0[:], b[22:55])
		copy(p.cav0[:], b[55:82])
		p.amt0 = in.Amount
	case len(b) == circuit.Spend2BodyLen && b[1] == circuit.KindSpend2:
		p.kind = circuit.KindSpend2
		p.lockSeq = binary.LittleEndian.Uint32(b[2:6])
		copy(p.salt[:], b[6:22])
		copy(p.owner0[:], b[22:55])
		p.amt0 = binary.LittleEndian.Uint64(b[55:63])
		copy(p.cav0[:], b[63:90])
	default:
		return p, fmt.Errorf("a body of %d bytes is not a message", len(b))
	}
	return p, nil
}

func (c *Chain) slotAndID(ids [][32]byte, i int) (slot, id [32]byte, err error) {
	m := c.Messages[i]
	if i == 0 {
		if len(m.Body) != circuit.IssueBodyLen {
			return slot, id, errors.New("the first message is not an issue")
		}
		copy(slot[:4], "ISSU")
		copy(slot[4:8], m.Body[67:71])
		end := binary.LittleEndian.Uint64(m.Body[71:79])
		binary.LittleEndian.PutUint64(slot[8:16], end-binary.LittleEndian.Uint64(m.Body[128:136]))
		binary.LittleEndian.PutUint64(slot[16:24], end)
	} else {
		slot = outputID(ids[i-1], c.Openings[i].Index)
	}
	content := sha(m.Body)
	return slot, sha(c.Domain[:], slot[:], content[:]), nil
}

func (c *Chain) ids() (slots, ids [][32]byte, err error) {
	if len(c.Messages) == 0 || len(c.Openings) != len(c.Messages) {
		return nil, nil, errors.New("a chain has one opening per message")
	}
	slots = make([][32]byte, len(c.Messages))
	ids = make([][32]byte, len(c.Messages))
	for i := range c.Messages {
		if slots[i], ids[i], err = c.slotAndID(ids, i); err != nil {
			return nil, nil, err
		}
	}
	return slots, ids, nil
}

func (c *Chain) nextBit(i int) uint8 {
	if i+1 < len(c.Openings) {
		return c.Openings[i+1].Index
	}
	return 0
}

// OutputIDs returns, for every message, the id of the output the next message consumes (output 0
// for the last). It needs only the bodies, the indices of the openings and the domain.
func OutputIDs(c *Chain) ([][32]byte, error) {
	_, ids, err := c.ids()
	if err != nil {
		return nil, err
	}
	out := make([][32]byte, len(ids))
	for i := range ids {
		out[i] = outputID(ids[i], c.nextBit(i))
	}
	return out, nil
}

// state is the commitment of output k of message j.
func (c *Chain) state(j int, k uint8) (*big.Int, error) {
	p, err := parse(c.Messages[j], c.Openings[j])
	if err != nil {
		return nil, err
	}
	salt := new(big.Int).SetBytes(p.salt[:])
	if k == 0 {
		return commit(p.owner0, new(big.Int).SetUint64(p.amt0), le(p.cav0[:]), scopeHash(p.owner0), salt), nil
	}
	in := c.Openings[j]
	change := new(big.Int).Sub(new(big.Int).SetUint64(in.Amount), new(big.Int).SetUint64(p.amt0))
	caveats := new(big.Int).Sub(le(in.Caveats[:]), two32)
	return commit(in.Owner, change, caveats, scopeHash(in.Owner), salt.Add(salt, two128)), nil
}

// Public10 holds the public inputs of one message.
type Public10 = [circuit.NumPublic]*big.Int

// Public returns the public inputs the program derives for message i, in the order of circuit.NumPublic.
func Public(c *Chain, i int) ([circuit.NumPublic]*big.Int, error) {
	var out [circuit.NumPublic]*big.Int
	_, ids, err := c.ids()
	if err != nil {
		return out, err
	}
	m := c.Messages[i]
	p, err := parse(m, c.Openings[i])
	if err != nil {
		return out, err
	}
	isIssue := p.kind == circuit.KindIssue
	isLast := !isIssue && i == len(c.Messages)-1
	ctrl := int64(0)
	if isIssue {
		ctrl += circuit.CtrlIssue
	}
	if isLast {
		ctrl += circuit.CtrlLast
	}
	if c.nextBit(i) == 1 {
		ctrl += circuit.CtrlNext1
	}
	sIn, sOut := new(big.Int), new(big.Int)
	if !isIssue && i > 0 {
		if sIn, err = c.state(i-1, c.Openings[i].Index); err != nil {
			return out, err
		}
	}
	if !isLast {
		if sOut, err = c.state(i, c.nextBit(i)); err != nil {
			return out, err
		}
	}
	var a [33]byte
	var mint [32]byte
	amt := new(big.Int)
	switch {
	case isIssue:
		copy(a[:], m.Body[2:35])
		copy(mint[:], m.Body[35:67])
		amt.SetUint64(p.amt0).Lsh(amt, 32).Add(amt, new(big.Int).SetUint64(uint64(p.lockSeq)))
	case isLast:
		a = p.owner0
		amt.SetUint64(p.amt0).Lsh(amt, 32).Add(amt, le(p.cav0[:4]))
	}
	id := ids[i]
	out = [circuit.NumPublic]*big.Int{
		new(big.Int).SetBytes(id[:16]), new(big.Int).SetBytes(id[16:]), big.NewInt(ctrl), sIn, sOut,
		new(big.Int).SetBytes(a[:17]), new(big.Int).SetBytes(a[17:]),
		new(big.Int).SetBytes(mint[:16]), new(big.Int).SetBytes(mint[16:]), amt,
	}
	if o := c.Override; o != nil && o.At == i {
		out[o.Index] = new(big.Int).Add(out[o.Index], o.Delta)
	}
	return out, nil
}

// scalar assigns x as the four 64-bit limbs of a P-256 scalar without reducing it modulo n, so
// that a value the circuit must refuse stays what it is.
func scalar(x *big.Int) emulated.Element[emulated.P256Fr] {
	mask := new(big.Int).SetUint64(math.MaxUint64)
	limbs := make([]frontend.Variable, 4)
	for i := range limbs {
		limbs[i] = new(big.Int).And(new(big.Int).Rsh(x, uint(64*i)), mask)
	}
	return emulated.Element[emulated.P256Fr]{Limbs: limbs}
}

func bytesOf(dst []uints.U8, src []byte) {
	for i := range dst {
		dst[i] = uints.NewU8(0)
	}
	for i, v := range src {
		dst[i] = uints.NewU8(v)
	}
}

// Assign builds the assignment of message i. It does not judge the message: an invalid one gets
// an assignment too, and it is the circuit that refuses it.
func Assign(c *Chain, i int) (*circuit.Message, error) {
	pub, err := Public(c, i)
	if err != nil {
		return nil, err
	}
	slots, _, err := c.ids()
	if err != nil {
		return nil, err
	}
	m, in := c.Messages[i], c.Openings[i]
	if len(m.Body) > circuit.MaxBody {
		return nil, errors.New("body longer than the longest message")
	}
	a := &circuit.Message{
		E:    [2]frontend.Variable{pub[0], pub[1]},
		Ctrl: pub[2], SIn: pub[3], SOut: pub[4],
		A:   [2]frontend.Variable{pub[5], pub[6]},
		B:   [2]frontend.Variable{pub[7], pub[8]},
		Amt: pub[9],
	}
	bytesOf(a.Body[:], m.Body)
	bytesOf(a.Domain[:], c.Domain[:])
	bytesOf(a.Slot[:], slots[i][:])
	bytesOf(a.In.Owner[:], in.Owner[:])
	bytesOf(a.In.Cav[:], in.Caveats[:])
	holder := scopeHash(in.Owner)
	a.In.Amount = new(big.Int).SetUint64(in.Amount)
	a.In.Holder = new(big.Int).SetBytes(holder[:])
	a.In.Blind = new(big.Int).Add(new(big.Int).SetBytes(in.Salt[:]), new(big.Int).Lsh(big.NewInt(int64(in.Index)), 128))
	a.Sig.R, a.Sig.S = scalar(m.R), scalar(m.S)
	return a, nil
}
