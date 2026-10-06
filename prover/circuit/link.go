package circuit

import (
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/math/uints"
)

// scopeHash is SHA-256("BPS1" || owner)[..20] as a big-endian integer.
func (e *env) scopeHash(owner []frontend.Variable) frontend.Variable {
	pre := []uints.U8{uints.NewU8('B'), uints.NewU8('P'), uints.NewU8('S'), uints.NewU8('1')}
	for i := range owner {
		pre = append(pre, e.bf.ValueOf(owner[i]))
	}
	return e.be(e.values(e.sha(pre, nil, 0)[:20]))
}
