package circuit

import (
	"math/big"

	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/algebra/emulated/sw_emulated"
	"github.com/consensys/gnark/std/hash"
	"github.com/consensys/gnark/std/hash/poseidon2"
	"github.com/consensys/gnark/std/hash/sha2"
	"github.com/consensys/gnark/std/math/emulated"
	"github.com/consensys/gnark/std/math/uints"
	"github.com/consensys/gnark/std/rangecheck"
	"github.com/consensys/gnark/std/signature/ecdsa"
)

// Opening is the state of the output a spend consumes. Its commitment is the public s_in.
type Opening struct {
	Owner  [33]uints.U8
	Amount frontend.Variable
	Cav    [27]uints.U8
	Holder frontend.Variable // scope_hash(owner) as a 160-bit big-endian integer
	Blind  frontend.Variable // the salt of the creating message plus index << 128
}

// Message proves one issue or spend of a note chain.
type Message struct {
	E    [2]frontend.Variable `gnark:",public"`
	Ctrl frontend.Variable    `gnark:",public"`
	SIn  frontend.Variable    `gnark:",public"`
	SOut frontend.Variable    `gnark:",public"`
	A    [2]frontend.Variable `gnark:",public"`
	B    [2]frontend.Variable `gnark:",public"`
	Amt  frontend.Variable    `gnark:",public"`

	Body   [MaxBody]uints.U8
	Domain [32]uints.U8
	Slot   [32]uints.U8
	In     Opening
	Sig    ecdsa.Signature[emulated.P256Fr]
}

var (
	two32  = new(big.Int).Lsh(big.NewInt(1), 32)
	two128 = new(big.Int).Lsh(big.NewInt(1), 128)
)

// env bundles the gadgets one Define shares.
type env struct {
	api   frontend.API
	bf    *uints.Bytes
	rc    frontend.Rangechecker
	fp    *emulated.Field[emulated.P256Fp]
	fr    *emulated.Field[emulated.P256Fr]
	curve *sw_emulated.Curve[emulated.P256Fp, emulated.P256Fr]
}

func newEnv(api frontend.API) (*env, error) {
	bf, err := uints.NewBytes(api)
	if err != nil {
		return nil, err
	}
	fp, err := emulated.NewField[emulated.P256Fp](api)
	if err != nil {
		return nil, err
	}
	fr, err := emulated.NewField[emulated.P256Fr](api)
	if err != nil {
		return nil, err
	}
	curve, err := sw_emulated.New[emulated.P256Fp, emulated.P256Fr](api, sw_emulated.GetP256Params())
	if err != nil {
		return nil, err
	}
	return &env{api: api, bf: bf, rc: rangecheck.New(api), fp: fp, fr: fr, curve: curve}, nil
}

// values range-checks witness bytes once and returns them as field elements.
func (e *env) values(u []uints.U8) []frontend.Variable {
	v := make([]frontend.Variable, len(u))
	for i := range u {
		v[i] = e.bf.Value(u[i])
	}
	return v
}

func (e *env) le(b []frontend.Variable) frontend.Variable {
	var acc frontend.Variable = 0
	for i := len(b) - 1; i >= 0; i-- {
		acc = e.api.Add(e.api.Mul(acc, 256), b[i])
	}
	return acc
}

func (e *env) be(b []frontend.Variable) frontend.Variable {
	var acc frontend.Variable = 0
	for i := range b {
		acc = e.api.Add(e.api.Mul(acc, 256), b[i])
	}
	return acc
}

// enc maps a 33-byte owner to (prefix << 128 | x[0:16], x[16:32]).
func (e *env) enc(o []frontend.Variable) (frontend.Variable, frontend.Variable) {
	return e.api.Add(e.api.Mul(o[0], two128), e.be(o[1:17])), e.be(o[17:33])
}

// bitsLSB returns the bits of a big-endian byte string, least significant first.
func (e *env) bitsLSB(b []frontend.Variable) []frontend.Variable {
	out := make([]frontend.Variable, 0, 8*len(b))
	for i := len(b) - 1; i >= 0; i-- {
		out = append(out, e.api.ToBinary(b[i], 8)...)
	}
	return out
}

func (e *env) sha(in []uints.U8, length frontend.Variable, minLen int) []uints.U8 {
	h, err := sha2.New(e.api, hash.WithMinimalLength(minLen))
	if err != nil {
		panic(err)
	}
	h.Write(in)
	if length == nil {
		return h.Sum()
	}
	return h.FixedLengthSum(length)
}

func (e *env) poseidon(in ...frontend.Variable) frontend.Variable {
	h, err := poseidon2.New(e.api)
	if err != nil {
		panic(err)
	}
	h.Write(in...)
	return h.Sum()
}

func (c *Message) Define(api frontend.API) error {
	e, err := newEnv(api)
	if err != nil {
		return err
	}
	b := e.values(c.Body[:])

	// Kind and control bits.
	ctl := api.ToBinary(c.Ctrl, 3)
	isIssue, isLast, next := ctl[0], ctl[1], ctl[2]
	isSpend := api.Sub(1, isIssue)
	api.AssertIsEqual(b[0], 1)
	isS1 := api.IsZero(api.Sub(b[1], KindSpend1))
	isS2 := api.IsZero(api.Sub(b[1], KindSpend2))
	api.AssertIsEqual(api.Add(isIssue, isS1, isS2), 1)
	api.AssertIsEqual(api.Mul(isIssue, api.Sub(b[1], KindIssue)), 0)
	api.AssertIsEqual(api.Mul(isIssue, isLast), 0)
	api.AssertIsEqual(api.Mul(isLast, next), 0)
	api.AssertIsEqual(api.Mul(next, api.Sub(1, isS2)), 0)
	length := api.Add(api.Mul(isIssue, IssueBodyLen), api.Mul(isS1, Spend1BodyLen), api.Mul(isS2, Spend2BodyLen))

	f := e.fields(b, c.In.Amount, isIssue, isSpend, isS1, isS2)

	// Message id and signature.
	slot := e.values(c.Slot[:])
	content := e.sha(c.Body[:], length, Spend1BodyLen)
	envelope := make([]uints.U8, 0, 96)
	envelope = append(envelope, c.Domain[:]...)
	envelope = append(envelope, c.Slot[:]...)
	envelope = append(envelope, content...)
	id := e.values(e.sha(envelope, nil, 0))
	api.AssertIsEqual(c.E[0], e.be(id[:16]))
	api.AssertIsEqual(c.E[1], e.be(id[16:]))
	msg := e.fr.FromBits(e.bitsLSB(id)...)

	inOwner := e.values(c.In.Owner[:])
	ci := e.values(c.In.Cav[:])
	signer := make([]frontend.Variable, 33)
	for i := range signer {
		signer[i] = api.Add(api.Mul(isIssue, b[2+i]), api.Mul(isSpend, inOwner[i]))
	}
	e.verifySignature(msg, &c.Sig, signer)

	// owner0 is a device key (decompressed like the signer) or a terminal account.
	p0 := f.owner0[0]
	api.AssertIsEqual(api.Mul(p0, api.Sub(p0, 2), api.Sub(p0, 3)), 0)
	isDev0 := api.Sub(1, api.IsZero(p0))
	e.decompress(p0, f.owner0[1:], isDev0)
	holder0 := e.scopeHash(f.owner0)

	e.caveatsOfOutput0(&f, holder0, isDev0)
	e.issueRules(&f, slot, isIssue)
	e.spendRules(c, &f, holder0, isDev0, isSpend, isS1, isS2, inOwner, ci)

	// State commitments: the consumed output and the output the next message consumes.
	inHi, inLo := e.enc(inOwner)
	cavIn := e.le(ci)
	sIn := e.poseidon(inHi, inLo, c.In.Amount, cavIn, c.In.Holder, c.In.Blind)
	api.AssertIsEqual(api.Mul(isSpend, api.Sub(c.SIn, sIn)), 0)
	api.AssertIsEqual(api.Mul(isIssue, c.SIn), 0)
	o0Hi, o0Lo := e.enc(f.owner0)
	s0 := e.poseidon(o0Hi, o0Lo, f.amt0, e.le(f.cav0), holder0, f.salt)
	s1 := e.poseidon(inHi, inLo, api.Sub(c.In.Amount, f.amt0), api.Sub(cavIn, 1<<32), c.In.Holder, api.Add(f.salt, two128))
	api.AssertIsEqual(c.SOut, api.Mul(api.Sub(1, isLast), api.Select(next, s1, s0)))

	// What the program needs in the clear.
	api.AssertIsEqual(api.Mul(isLast, isDev0), 0)
	issHi, issLo := e.enc(b[2:35])
	api.AssertIsEqual(c.A[0], api.Add(api.Mul(isIssue, issHi), api.Mul(isLast, o0Hi)))
	api.AssertIsEqual(c.A[1], api.Add(api.Mul(isIssue, issLo), api.Mul(isLast, o0Lo)))
	api.AssertIsEqual(c.B[0], api.Mul(isIssue, e.be(b[35:51])))
	api.AssertIsEqual(c.B[1], api.Mul(isIssue, e.be(b[51:67])))
	head := api.Mul(f.amt0, two32)
	api.AssertIsEqual(c.Amt, api.Add(api.Mul(isLast, api.Add(head, f.exp0)), api.Mul(isIssue, api.Add(head, f.lockSeq))))
	return nil
}
