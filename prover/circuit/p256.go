package circuit

import (
	"math/big"

	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/algebra/emulated/sw_emulated"
	"github.com/consensys/gnark/std/math/emulated"
	"github.com/consensys/gnark/std/signature/ecdsa"
)

var (
	p256Params = sw_emulated.GetP256Params()
	pMinus1    = new(big.Int).Sub(emulated.P256Fp{}.Modulus(), big.NewInt(1))
	nMinus1    = new(big.Int).Sub(emulated.P256Fr{}.Modulus(), big.NewInt(1))
	halfN      = new(big.Int).Rsh(emulated.P256Fr{}.Modulus(), 1)
)

// decompress returns the point of a compressed key: x < p from its 32 big-endian bytes, y from the
// DecompressY hint, checked against the curve equation and the parity in the prefix byte. With
// enabled set, every check is conditional on it, so that a terminal account passes through with
// the same code; nil means always.
func (e *env) decompress(prefix frontend.Variable, xBytes []frontend.Variable, enabled frontend.Variable) (*emulated.Element[emulated.P256Fp], *emulated.Element[emulated.P256Fp]) {
	api, fp := e.api, e.fp
	x := fp.FromBits(e.bitsLSB(xBytes)...)
	odd := api.Sub(prefix, 2)
	if enabled != nil {
		x = fp.Select(enabled, x, fp.Zero())
		odd = api.Mul(enabled, odd)
	}
	fp.AssertIsLessOrEqual(x, fp.NewElement(pMinus1))
	ys, err := fp.NewHint(DecompressY, 1, x, fp.FromBits(odd))
	if err != nil {
		panic(err)
	}
	y := ys[0]
	rhs := fp.Add(fp.Sub(fp.Mul(fp.Mul(x, x), x), fp.MulConst(x, big.NewInt(3))), fp.NewElement(p256Params.B))
	yy := fp.Mul(y, y)
	parity := fp.ToBitsCanonical(y)[0]
	if enabled == nil {
		fp.AssertIsEqual(yy, rhs)
		api.AssertIsEqual(parity, odd)
		return x, y
	}
	api.AssertIsEqual(api.Mul(enabled, api.Sub(1, fp.IsZero(fp.Sub(yy, rhs)))), 0)
	api.AssertIsEqual(api.Mul(enabled, api.Sub(parity, odd)), 0)
	return x, y
}

// verifySignature checks a low-S ECDSA signature by the compressed key signer over the message.
// The signature scalars are in [1, n-1]: gnark rejects zero and allows n, so n is excluded here.
func (e *env) verifySignature(msg *emulated.Element[emulated.P256Fr], sig *ecdsa.Signature[emulated.P256Fr], signer []frontend.Variable) {
	api := e.api
	api.AssertIsEqual(api.Mul(api.Sub(signer[0], 2), api.Sub(signer[0], 3)), 0)
	x, y := e.decompress(signer[0], signer[1:], nil)
	pk := ecdsa.PublicKey[emulated.P256Fp, emulated.P256Fr]{X: *x, Y: *y}
	e.fr.AssertIsLessOrEqual(&sig.R, e.fr.NewElement(nMinus1))
	e.fr.AssertIsLessOrEqual(&sig.S, e.fr.NewElement(halfN))
	pk.Verify(api, p256Params, msg, sig)
}
