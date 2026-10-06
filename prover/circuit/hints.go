package circuit

import (
	"errors"
	"math/big"

	"github.com/consensys/gnark/constraint/solver"
	"github.com/consensys/gnark/std/math/emulated"
)

func init() { solver.RegisterHint(DecompressY) }

var p256B, _ = new(big.Int).SetString("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", 16)

// DecompressY is the hint that returns the y of a compressed P-256 point: inputs x and the parity
// bit (both as emulated elements), output the root of y^2 = x^3 - 3x + b with that parity. A
// value that is not on the curve gives y = 0; the circuit decides whether that is acceptable.
func DecompressY(_ *big.Int, inputs, outputs []*big.Int) error {
	return emulated.UnwrapHint(inputs, outputs, DecompressYField)
}

// DecompressYField is DecompressY on values reduced modulo the P-256 field prime p.
func DecompressYField(p *big.Int, inputs, outputs []*big.Int) error {
	if len(inputs) != 2 || len(outputs) != 1 {
		return errors.New("decompress: expecting x and the parity, one output")
	}
	x := inputs[0]
	rhs := new(big.Int).Mul(x, x)
	rhs.Sub(rhs, big.NewInt(3))
	rhs.Mul(rhs, x)
	rhs.Add(rhs, p256B).Mod(rhs, p)
	y := new(big.Int).ModSqrt(rhs, p)
	if y == nil {
		outputs[0].SetUint64(0)
		return nil
	}
	if y.Bit(0) != inputs[1].Bit(0) {
		y.Sub(p, y)
	}
	outputs[0].Set(y)
	return nil
}
