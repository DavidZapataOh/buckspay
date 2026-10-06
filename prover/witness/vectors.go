package witness

import (
	"encoding/hex"
	"encoding/json"
	"math/big"
)

// SignedJSON, OpeningJSON, ValidCase and InvalidCase mirror the file written by the vector generator.
type SignedJSON struct {
	Kind uint8  `json:"kind"`
	Body string `json:"body"`
	SigR string `json:"sig_r"`
	SigS string `json:"sig_s"`
	Key  string `json:"key"`
}

type OpeningJSON struct {
	Owner   string `json:"owner"`
	Amount  uint64 `json:"amount"`
	Caveats string `json:"caveats"`
	Salt    string `json:"salt"`
	Index   uint8  `json:"index"`
}

type OverrideJSON struct {
	Index int    `json:"index"`
	Delta string `json:"delta"`
}

type ValidCase struct {
	Name       string        `json:"name"`
	Messages   []SignedJSON  `json:"messages"`
	Openings   []OpeningJSON `json:"openings"`
	MessageIDs []string      `json:"message_ids"`
	OutputIDs  [][2]string   `json:"output_ids"`
	Public     [][10]string  `json:"public"`
	domain     string
}

type InvalidCase struct {
	Name           string        `json:"name"`
	Reason         string        `json:"reason"`
	Messages       []SignedJSON  `json:"messages"`
	Openings       []OpeningJSON `json:"openings"`
	Bad            int           `json:"bad"`
	PublicOverride *OverrideJSON `json:"public_override"`
	domain         string
}

type Vectors struct {
	Domain  string        `json:"domain"`
	Valid   []ValidCase   `json:"valid"`
	Invalid []InvalidCase `json:"invalid"`
}

// UnmarshalJSON decodes the generator output and hands the domain to every case.
func (v *Vectors) UnmarshalJSON(b []byte) error {
	type plain Vectors
	if err := json.Unmarshal(b, (*plain)(v)); err != nil {
		return err
	}
	for i := range v.Valid {
		v.Valid[i].domain = v.Domain
	}
	for i := range v.Invalid {
		v.Invalid[i].domain = v.Domain
	}
	return nil
}

// ByName returns the valid chain called name, or nil.
func (v *Vectors) ByName(name string) *ValidCase {
	for i := range v.Valid {
		if v.Valid[i].Name == name {
			return &v.Valid[i]
		}
	}
	return nil
}

func (c *ValidCase) Chain() *Chain { return buildChain(c.domain, c.Messages, c.Openings, nil) }

// NextBit is the output of message i that message i+1 consumes, 0 for the last message.
func (c *ValidCase) NextBit(i int) int {
	if i+1 < len(c.Openings) {
		return int(c.Openings[i+1].Index)
	}
	return 0
}

func (c *InvalidCase) Chain() *Chain {
	var o *Override
	if c.PublicOverride != nil {
		d, _ := new(big.Int).SetString(c.PublicOverride.Delta, 10)
		o = &Override{At: c.Bad, Index: c.PublicOverride.Index, Delta: d}
	}
	return buildChain(c.domain, c.Messages, c.Openings, o)
}

func buildChain(domain string, ms []SignedJSON, os []OpeningJSON, o *Override) *Chain {
	c := &Chain{Override: o}
	d, _ := hex.DecodeString(domain)
	copy(c.Domain[:], d)
	for _, m := range ms {
		s := Signed{Kind: m.Kind}
		s.Body, _ = hex.DecodeString(m.Body)
		r, _ := hex.DecodeString(m.SigR)
		sg, _ := hex.DecodeString(m.SigS)
		k, _ := hex.DecodeString(m.Key)
		s.R, s.S = new(big.Int).SetBytes(r), new(big.Int).SetBytes(sg)
		copy(s.Key[:], k)
		c.Messages = append(c.Messages, s)
	}
	for _, o := range os {
		var op Opening
		ow, _ := hex.DecodeString(o.Owner)
		cv, _ := hex.DecodeString(o.Caveats)
		sl, _ := hex.DecodeString(o.Salt)
		copy(op.Owner[:], ow)
		copy(op.Caveats[:], cv)
		copy(op.Salt[:], sl)
		op.Amount, op.Index = o.Amount, o.Index
		c.Openings = append(c.Openings, op)
	}
	return c
}
