package netting

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
)

func TestSlotIndexIsLexicographic(t *testing.T) {
	s := 0
	for i := 0; i < MaxParticipants; i++ {
		for j := i + 1; j < MaxParticipants; j++ {
			if SlotIndex(i, j) != s {
				t.Fatalf("slot of (%d,%d) is %d, want %d", i, j, SlotIndex(i, j), s)
			}
			if a, b := Ends(s); a != i || b != j {
				t.Fatalf("ends of %d are (%d,%d)", s, a, b)
			}
			s++
		}
	}
	if s != Slots {
		t.Fatalf("%d slots", s)
	}
}

// The protocol crate's golden vectors hold the netting statements; the Go mirror must agree byte for byte.
type protocolVectors struct {
	Netting struct {
		Statements []struct {
			Body          string
			Content       string
			SessionField  string   `json:"session_field"`
			PublicInputs  []string `json:"public_inputs"`
			NettingAdress struct {
				Production *string
				Short      *string
			} `json:"netting_address"`
		}
	}
	NettingInvalid []struct{ Type, Body, Error string }
}

func loadProtocolVectors(t *testing.T) protocolVectors {
	t.Helper()
	raw, err := os.ReadFile("../../anchor/crates/protocol/tests/vectors/v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var v protocolVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestStatementMatchesProtocolVectors(t *testing.T) {
	v := loadProtocolVectors(t)
	if len(v.Netting.Statements) < 3 {
		t.Fatalf("%d netting vectors", len(v.Netting.Statements))
	}
	for _, c := range v.Netting.Statements {
		body, _ := hex.DecodeString(c.Body)
		st, err := DecodeStatement(body)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(st.Encode(), body) {
			t.Fatal("encode differs")
		}
		content := st.Content()
		sf := SessionField(st)
		if hex.EncodeToString(content[:]) != c.Content || hex.EncodeToString(sf[:]) != c.SessionField {
			t.Fatal("content or session field differs")
		}
		for i, p := range st.Public() {
			if hex.EncodeToString(p[:]) != c.PublicInputs[i] {
				t.Fatalf("public input %d differs", i)
			}
		}
	}
	refused := 0
	for _, c := range v.NettingInvalid {
		if c.Type != "statement" {
			continue
		}
		b, _ := hex.DecodeString(c.Body)
		if _, err := DecodeStatement(b); err == nil {
			t.Fatalf("accepted invalid statement (%s)", c.Error)
		}
		refused++
	}
	if refused < 4 {
		t.Fatalf("only %d invalid statements checked", refused)
	}
}

// The fixture generator grinds with RecordAddress; it must be Solana's create_program_address. The vectors hold
// each statement's netting address under the production and the short-windows program ids, null when the result
// is on the curve.
func TestRecordAddressMatchesProtocolVectors(t *testing.T) {
	programs := map[string]string{
		"production": "0ecb12cbf5951c1c2fb397058b193fbbf9e5d9147acf85def071a692359981b4",
		"short":      "feecdb7b28b04a8dc9f0c9f09afe7ff0bbd03497c9a4c4faaebb50504678f056",
	}
	v := loadProtocolVectors(t)
	checked := 0
	for _, c := range v.Netting.Statements {
		body, _ := hex.DecodeString(c.Body)
		st, err := DecodeStatement(body)
		if err != nil {
			t.Fatal(err)
		}
		for name, want := range map[string]*string{"production": c.NettingAdress.Production, "short": c.NettingAdress.Short} {
			var id [32]byte
			b, _ := hex.DecodeString(programs[name])
			copy(id[:], b)
			got, ok := RecordAddress(id, st.Content())
			if (want == nil) == ok || (ok && hex.EncodeToString(got[:]) != *want) {
				t.Fatalf("address under %s differs", name)
			}
			checked++
		}
	}
	if checked < 6 {
		t.Fatalf("only %d addresses checked", checked)
	}
}

func TestWitnessWireRoundTrips(t *testing.T) {
	for _, c := range []struct {
		n int
		d []debt
	}{{2, debts2}, {5, debts5}, {8, debts8}} {
		st, slots := build(t, c.n, c.d)
		wire := EncodeWitness(st, slots)
		if len(wire) != 111+32*c.n+Slots*SlotWireLen {
			t.Fatalf("witness of %d bytes", len(wire))
		}
		st2, slots2, err := DecodeWitness(wire)
		if err != nil || !bytes.Equal(st2.Encode(), st.Encode()) || slots2 != slots {
			t.Fatalf("round trip: %v", err)
		}
		for name, bad := range map[string][]byte{
			"short":           wire[:len(wire)-1],
			"long":            append(append([]byte{}, wire...), 0),
			"absent_not_zero": withByte(wire, 111+32*c.n+SlotIndex(3, 6)*SlotWireLen+40, 1),
			"dir_two":         withByte(wire, 111+32*c.n+SlotIndex(0, 1)*SlotWireLen+69, 2),
			"present_two":     withByte(wire, 111+32*c.n+SlotIndex(0, 1)*SlotWireLen, 2),
		} {
			if _, _, err := DecodeWitness(bad); err == nil {
				t.Fatalf("%s accepted", name)
			}
		}
	}
}

func withByte(b []byte, at int, v byte) []byte {
	out := append([]byte{}, b...)
	out[at] = v
	return out
}

func TestAssignRefusesBadWitness(t *testing.T) {
	s01, s34 := SlotIndex(0, 1), SlotIndex(3, 4)
	reseal := func(st *Statement, slots *[Slots]WitnessSlot) {
		var d [MaxParticipants]fr.Element
		for p := range d {
			d[p], _ = Digest(SessionField(*st), p, slots)
		}
		st.Root = rootBytes(d)
	}
	cases := map[string]func(*Statement, *[Slots]WitnessSlot){
		"root_mismatch": func(st *Statement, _ *[Slots]WitnessSlot) { st.Root[31] ^= 1 },
		"inactive_slot_debt": func(st *Statement, s *[Slots]WitnessSlot) {
			s[SlotIndex(0, 6)] = s[s34]
			s[s34] = WitnessSlot{}
			reseal(st, s)
		},
		"cancel_above_debt":  func(st *Statement, s *[Slots]WitnessSlot) { s[s01].Debt = 4; reseal(st, s) },
		"total_mismatch":     func(st *Statement, _ *[Slots]WitnessSlot) { st.Total++ },
		"net_changed":        func(st *Statement, s *[Slots]WitnessSlot) { s[s01].Cancel++; st.Total++; reseal(st, s) },
		"salt_not_canonical": func(st *Statement, s *[Slots]WitnessSlot) { s[s01].Salt = [32]byte{0xff, 0xff}; reseal(st, s) },
		"absent_with_bytes":  func(st *Statement, s *[Slots]WitnessSlot) { s[SlotIndex(0, 3)].Seq = 1 },
		"dir_above_one":      func(st *Statement, s *[Slots]WitnessSlot) { s[s01].Dir = 2 },
		"keys_not_n":         func(st *Statement, _ *[Slots]WitnessSlot) { st.Ephemeral = st.Ephemeral[:4] },
		"cancels_overflow_u64": func(st *Statement, s *[Slots]WitnessSlot) {
			for _, p := range [][2]int{{0, 1}, {1, 2}, {0, 2}} {
				s[SlotIndex(p[0], p[1])].Debt, s[SlotIndex(p[0], p[1])].Cancel = 1<<63, 1<<63
			}
			st.Total = 1 << 63 // the wrapped sum of 3 · 2^63
			reseal(st, s)
		},
	}
	for name, alter := range cases {
		t.Run(name, func(t *testing.T) {
			st, slots := build(t, 5, debts5)
			alter(&st, &slots)
			if _, err := Assign(st, slots); !errors.Is(err, ErrWitness) {
				t.Fatalf("got %v, want ErrWitness", err)
			}
		})
	}
}

func TestVectorsFileIsCurrent(t *testing.T) {
	want, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	got, err := VectorsJSON()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("testdata/vectors.json is stale: run `buckspay-zk netting vectors`")
	}
}
