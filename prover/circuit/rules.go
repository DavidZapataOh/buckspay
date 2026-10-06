package circuit

import (
	"github.com/consensys/gnark/frontend"
)

// fields are the values of a body that depend on its kind: spends share offsets up to owner0.
type fields struct {
	b                     []frontend.Variable
	lockSeq, salt, amt0   frontend.Variable
	owner0, cav0          []frontend.Variable
	exp0, hops0, sk0, sc0 frontend.Variable
	fl0                   []frontend.Variable
}

func (e *env) fields(b []frontend.Variable, amountIn, isIssue, isSpend, isS1, isS2 frontend.Variable) fields {
	api := e.api
	pick := func(vi, vs frontend.Variable) frontend.Variable {
		return api.Add(api.Mul(isIssue, vi), api.Mul(isSpend, vs))
	}
	f := fields{b: b}
	f.lockSeq = pick(e.le(b[67:71]), e.le(b[2:6]))
	f.salt = pick(e.be(b[79:95]), e.be(b[6:22]))
	f.owner0 = make([]frontend.Variable, 33)
	for i := range f.owner0 {
		f.owner0[i] = pick(b[95+i], b[22+i])
	}
	f.cav0 = make([]frontend.Variable, 27)
	for i := range f.cav0 {
		f.cav0[i] = api.Add(api.Mul(isIssue, b[136+i]), api.Mul(isS1, b[55+i]), api.Mul(isS2, b[63+i]))
	}
	f.amt0 = api.Add(api.Mul(isIssue, e.le(b[128:136])), api.Mul(isS1, amountIn), api.Mul(isS2, e.le(b[55:63])))
	f.exp0, f.hops0, f.sk0 = e.le(f.cav0[0:4]), f.cav0[4], f.cav0[6]
	f.sc0 = e.be(f.cav0[7:27])
	return f
}

// caveatsOfOutput0 asserts that the caveats of the first output are canonical (Caveats::check) and
// that a device is not the authority of its own output (Caveats::check_holder).
func (e *env) caveatsOfOutput0(f *fields, holder0, isDev0 frontend.Variable) {
	api := e.api
	f.fl0 = api.ToBinary(f.cav0[5], 8)
	for i := 2; i < 8; i++ {
		api.AssertIsEqual(f.fl0[i], 0)
	}
	e.rc.Check(f.sk0, 2)
	api.AssertIsEqual(api.Mul(api.IsZero(f.sk0), f.sc0), 0)
	api.AssertIsEqual(api.Mul(api.IsZero(api.Sub(f.sk0, 2)), e.be(f.cav0[9:27])), 0)
	api.AssertIsEqual(api.Mul(f.fl0[1], api.Sub(f.sk0, 3)), 0)
	api.AssertIsEqual(api.Mul(api.IsZero(api.Sub(f.sk0, 3)), api.IsZero(api.Sub(f.sc0, holder0)), isDev0), 0)
}

// issueRules are the rules of an issue and its slot "ISSU" || lock_seq || start || end || 0^8.
func (e *env) issueRules(f *fields, slot []frontend.Variable, isIssue frontend.Variable) {
	api, b := e.api, f.b
	e.rc.Check(api.Mul(isIssue, api.Sub(MaxHops, f.hops0)), 8)
	api.AssertIsEqual(api.Mul(isIssue, api.IsZero(api.Sub(f.lockSeq, NoLock))), 0)
	e.rc.Check(api.Mul(isIssue, api.Sub(f.amt0, 1)), 64)
	start := api.ToBinary(api.Mul(isIssue, api.Sub(e.le(b[71:79]), f.amt0)), 64)
	want := []frontend.Variable{'I', 'S', 'S', 'U'}
	want = append(want, b[67:71]...)
	for i := 0; i < 8; i++ {
		want = append(want, api.FromBinary(start[8*i:8*i+8]...))
	}
	want = append(want, b[71:79]...)
	for i := 0; i < 8; i++ {
		want = append(want, 0)
	}
	for i := range want {
		api.AssertIsEqual(api.Mul(isIssue, api.Sub(slot[i], want[i])), 0)
	}
}

// spendRules are the rules of a hop against the consumed output: amounts, change, attenuation,
// expiry step, scope and lock.
func (e *env) spendRules(c *Message, f *fields, holder0, isDev0, isSpend, isS1, isS2 frontend.Variable, inOwner, ci []frontend.Variable) {
	api, b := e.api, f.b
	expIn, hopsIn, skIn := e.le(ci[0:4]), ci[4], ci[6]
	scIn := e.be(ci[7:27])
	flIn := api.ToBinary(ci[5], 8)
	lift := api.Mul(api.IsZero(api.Sub(skIn, 1)), api.IsZero(api.Sub(scIn, c.In.Holder)))
	effK := api.Mul(skIn, api.Sub(1, lift))
	effS := api.Mul(scIn, api.Sub(1, lift))

	e.rc.Check(api.Mul(isSpend, api.Sub(expIn, f.exp0)), 32)
	e.rc.Check(api.Mul(isSpend, isDev0, api.Sub(api.Sub(expIn, f.exp0), ExpiryStep)), 32)
	e.rc.Check(api.Mul(isSpend, api.Sub(api.Sub(hopsIn, 1), f.hops0)), 8)
	e.rc.Check(api.Mul(isS2, api.Sub(hopsIn, 2)), 8)
	api.AssertIsEqual(api.Mul(isSpend, api.Sub(f.fl0[1], flIn[1])), 0)
	scoped := api.Mul(isSpend, api.Sub(1, api.IsZero(effK)))
	api.AssertIsEqual(api.Mul(scoped, api.Sub(f.sk0, effK)), 0)
	api.AssertIsEqual(api.Mul(scoped, api.Sub(f.sc0, effS)), 0)
	payeeScoped := api.Mul(isSpend, api.Add(api.IsZero(api.Sub(effK, 1)), api.IsZero(api.Sub(effK, 3))))
	api.AssertIsEqual(api.Mul(payeeScoped, api.Sub(holder0, effS)), 0)
	e.rc.Check(api.Mul(isS2, api.Sub(f.amt0, 1)), 64)
	e.rc.Check(api.Mul(isS2, api.Sub(api.Sub(c.In.Amount, f.amt0), 1)), 64)
	for i := 0; i < 33; i++ {
		api.AssertIsEqual(api.Mul(isS2, api.Sub(b[90+i], inOwner[i])), 0)
	}
	noLock := api.Mul(isSpend, api.IsZero(api.Sub(f.lockSeq, NoLock)))
	settle := api.Mul(isS1, api.Sub(1, isDev0))
	allowed := api.Sub(1, api.Mul(api.Sub(1, flIn[0]), api.Sub(1, flIn[1]), api.Sub(1, settle)))
	api.AssertIsEqual(api.Mul(noLock, api.Sub(1, allowed)), 0)
	api.AssertIsEqual(api.Mul(noLock, f.fl0[0]), 0)
}
