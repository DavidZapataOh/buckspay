package netting

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"filippo.io/edwards25519"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"

	"github.com/DavidZapataOh/buckspay/prover/poseidon"
)

const (
	tabTag  = "BUCKSPAY:v1:netting-tab"
	saltTag = "BUCKSPAY:v1:netting-salt"

	recordSeed = "netting"
	recordBump = 255
)

func fieldHash(parts ...[]byte) (out [32]byte) {
	h := sha256.New()
	for _, p := range parts {
		h.Write(p)
	}
	h.Sum(out[:0])
	out[0] &= 0x1f
	return out
}

func element(b [32]byte) fr.Element {
	var e fr.Element
	e.SetBytes(b[:])
	return e
}

// TabField maps a tab id to the field element a leaf commits to.
func TabField(tab [32]byte) fr.Element { return element(fieldHash([]byte(tabTag), tab[:])) }

// SaltFor derives the salt of a tab from its secret and the session. Both endpoints of the tab compute it.
func SaltFor(secret, session [32]byte) [32]byte {
	return fieldHash([]byte(saltTag), secret[:], session[:])
}

func canonical(b [32]byte) (fr.Element, error) {
	var e fr.Element
	if err := e.SetBytesCanonical(b[:]); err != nil {
		return e, errors.New("not a canonical field element")
	}
	return e, nil
}

// Leaf is the commitment to one slot: P(P(P(P(salt, tab), seq·2+dir), debt), cancel). An absent slot must carry
// no data and commits to the empty leaf.
func Leaf(w WitnessSlot) (fr.Element, error) {
	var salt, tab, seqDir, debt, cancel fr.Element
	if w.Present {
		var err error
		if salt, err = canonical(w.Salt); err != nil {
			return salt, fmt.Errorf("salt: %w", err)
		}
		if w.Dir > 1 {
			return salt, fmt.Errorf("direction %d", w.Dir)
		}
		tab = TabField(w.Tab)
		seqDir.SetUint64(uint64(w.Seq)*2 + uint64(w.Dir))
		debt.SetUint64(w.Debt)
		cancel.SetUint64(w.Cancel)
	} else if w != (WitnessSlot{}) {
		return salt, errors.New("absent slot with data")
	}
	l := poseidon.Native(salt, tab)
	l = poseidon.Native(l, seqDir)
	l = poseidon.Native(l, debt)
	return poseidon.Native(l, cancel), nil
}

// Digest is the commitment of participant p: the session field, then the leaves of the slots p shares with the
// other seven participants, in increasing order of the other index.
func Digest(sessionField [32]byte, p int, slots *[Slots]WitnessSlot) (fr.Element, error) {
	if p < 0 || p >= MaxParticipants {
		return fr.Element{}, fmt.Errorf("participant %d", p)
	}
	session, err := canonical(sessionField)
	if err != nil {
		return session, fmt.Errorf("session field: %w", err)
	}
	var index fr.Element
	index.SetUint64(uint64(p))
	d := poseidon.Native(session, index)
	for q := 0; q < MaxParticipants; q++ {
		if q == p {
			continue
		}
		l, err := Leaf(slots[SlotIndex(min(p, q), max(p, q))])
		if err != nil {
			return l, err
		}
		d = poseidon.Native(d, l)
	}
	return d, nil
}

// RootOf chains the eight digests.
func RootOf(d [MaxParticipants]fr.Element) fr.Element {
	root := d[0]
	for p := 1; p < MaxParticipants; p++ {
		root = poseidon.Native(root, d[p])
	}
	return root
}

// RecordAddress is the program-derived address of a netting record (seeds "netting", content and bump 255),
// computed as Solana's create_program_address: false when the result is a point of the curve.
func RecordAddress(program, content [32]byte) ([32]byte, bool) {
	h := sha256.New()
	h.Write([]byte(recordSeed))
	h.Write(content[:])
	h.Write([]byte{recordBump})
	h.Write(program[:])
	h.Write([]byte("ProgramDerivedAddress"))
	var out [32]byte
	h.Sum(out[:0])
	if _, err := new(edwards25519.Point).SetBytes(out[:]); err == nil {
		return out, false
	}
	return out, true
}

// ---- examples and vectors ----

type exampleDebt struct {
	from, to       int
	amount, cancel uint64
}

func exampleDebts(n int) []exampleDebt {
	switch n {
	case 2:
		return []exampleDebt{{0, 1, 10, 0}}
	case 5:
		return []exampleDebt{{0, 1, 10, 5}, {1, 2, 7, 5}, {2, 0, 5, 5}, {3, 4, 9, 0}, {1, 3, 4, 0}}
	case 8:
		return []exampleDebt{
			{0, 1, 1<<64 - 1, 1 << 61}, {1, 5, 1 << 63, 1 << 61}, {5, 7, 1<<63 + 5, 1 << 61}, {7, 0, 3 << 62, 1 << 61},
			{2, 3, 3, 3}, {3, 4, 3, 3}, {4, 2, 3, 3}, {6, 2, 1, 0},
		}
	}
	panic("netting: no example for " + strconv.Itoa(n) + " participants")
}

func exampleLabel(seed int, name string, parts ...int) [32]byte {
	b := []byte("buckspay/netting-vectors/" + strconv.Itoa(seed) + "/" + name)
	for _, p := range parts {
		b = binary.LittleEndian.AppendUint32(b, uint32(p))
	}
	return sha256.Sum256(b)
}

// ExampleKey is the ephemeral signing key of participant p in every example: public test material.
func ExampleKey(p int) ed25519.PrivateKey {
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(0x40 + p)
	}
	return ed25519.NewKeyFromSeed(seed)
}

// Example is an honest netting among n participants (2, 5 or 8) with the vectors' labels.
func Example(n int) (Statement, [Slots]WitnessSlot) { return ExampleWith(n, 0, 4_000_000_000) }

// ExampleWith is Example with another seed and expiry; the session, salts, tabs, session field and root follow.
func ExampleWith(n, seed int, expires uint32) (Statement, [Slots]WitnessSlot) {
	st, slots, _ := example(n, seed, expires)
	return st, slots
}

func example(n, seed int, expires uint32) (Statement, [Slots]WitnessSlot, [Slots][32]byte) {
	session := exampleLabel(seed, "session", n)
	var slots [Slots]WitnessSlot
	var secrets [Slots][32]byte
	var total uint64
	for k, d := range exampleDebts(n) {
		i, j, dir := d.from, d.to, uint8(0)
		if i > j {
			i, j, dir = j, i, 1
		}
		s := SlotIndex(i, j)
		secrets[s] = exampleLabel(seed, "secret", i, j)
		slots[s] = WitnessSlot{Present: true, Salt: SaltFor(secrets[s], session), Tab: exampleLabel(seed, "tab", i, j),
			Seq: uint32(7 + k), Dir: dir, Debt: d.amount, Cancel: d.cancel}
		total += d.cancel
	}
	st := Statement{Session: session, Mint: [32]byte{0x4d}, Participants: uint8(n), Total: total, Expires: expires}
	for p := 0; p < n; p++ {
		var k [32]byte
		copy(k[:], ExampleKey(p).Public().(ed25519.PublicKey))
		st.Ephemeral = append(st.Ephemeral, k)
	}
	var d [MaxParticipants]fr.Element
	for p := range d {
		d[p], _ = Digest(SessionField(st), p, &slots)
	}
	st.Root = bytesOf(RootOf(d))
	return st, slots, secrets
}

type slotJSON struct {
	Index   int    `json:"index"`
	Present bool   `json:"present"`
	TabID   string `json:"tabId"`
	TabSeed string `json:"tabSeed"`
	Salt    string `json:"salt"`
	Tab     string `json:"tab"`
	Seq     uint32 `json:"seq"`
	Dir     uint8  `json:"dir"`
	Debt    string `json:"debt"`
	Cancel  string `json:"cancel"`
	Leaf    string `json:"leaf"`
}

type caseJSON struct {
	Name         string     `json:"name"`
	Statement    string     `json:"statement"`
	Content      string     `json:"content"`
	Session      string     `json:"session"`
	SessionField string     `json:"sessionField"`
	Public       []string   `json:"public"`
	Slots        []slotJSON `json:"slots"`
	Digests      []string   `json:"digests"`
	Root         string     `json:"root"`
	Witness      string     `json:"witness"`
}

type vectorsJSON struct {
	EmptyLeaf string     `json:"emptyLeaf"`
	Cases     []caseJSON `json:"cases"`
}

func hex32(b [32]byte) string { return hex.EncodeToString(b[:]) }

// VectorsJSON is the content of testdata/vectors.json: the digests, leaves, roots and witness bytes of the three
// examples, which the TypeScript mirror must reproduce. Nothing in it is secret.
func VectorsJSON() ([]byte, error) {
	empty, err := Leaf(WitnessSlot{})
	if err != nil {
		return nil, err
	}
	out := vectorsJSON{EmptyLeaf: hex32(bytesOf(empty))}
	for _, n := range []int{2, 5, 8} {
		st, slots, secrets := example(n, 0, 4_000_000_000)
		c := caseJSON{
			Name: "n" + strconv.Itoa(n), Statement: hex.EncodeToString(st.Encode()),
			Session: hex32(st.Session), Root: hex32(st.Root), Witness: hex.EncodeToString(EncodeWitness(st, slots)),
		}
		content := st.Content()
		c.Content = hex32(content)
		c.SessionField = hex32(SessionField(st))
		for _, p := range st.Public() {
			c.Public = append(c.Public, hex32(p))
		}
		for s, w := range slots {
			l, err := Leaf(w)
			if err != nil {
				return nil, err
			}
			j := slotJSON{Index: s, Present: w.Present, Debt: "0", Cancel: "0", Salt: hex32([32]byte{}), Tab: hex32([32]byte{}),
				TabID: hex32([32]byte{}), TabSeed: hex32([32]byte{}), Leaf: hex32(bytesOf(l))}
			if w.Present {
				j.TabID, j.TabSeed, j.Salt = hex32(w.Tab), hex32(secrets[s]), hex32(w.Salt)
				j.Tab = hex32(bytesOf(TabField(w.Tab)))
				j.Seq, j.Dir = w.Seq, w.Dir
				j.Debt, j.Cancel = strconv.FormatUint(w.Debt, 10), strconv.FormatUint(w.Cancel, 10)
			}
			c.Slots = append(c.Slots, j)
		}
		for p := 0; p < MaxParticipants; p++ {
			d, err := Digest(SessionField(st), p, &slots)
			if err != nil {
				return nil, err
			}
			c.Digests = append(c.Digests, hex32(bytesOf(d)))
		}
		out.Cases = append(out.Cases, c)
	}
	raw, err := json.MarshalIndent(out, "", "  ")
	return append(raw, '\n'), err
}

func bytesOf(e fr.Element) [32]byte { return e.Bytes() }
