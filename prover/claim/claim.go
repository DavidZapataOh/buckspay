// Package claim is the circuit of a blind reward claim: it proves knowledge of the secrets of one
// leaf of a reward tree and binds the claim to a recipient, a fee ceiling and a scope, without
// revealing which leaf.
package claim

import (
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/std/math/bits"

	"github.com/DavidZapataOh/buckspay/prover/poseidon"
)

const (
	// Depth is the depth of a reward tree.
	Depth = 20
	// NumPublic is the number of public inputs of the circuit.
	NumPublic = 7
	// MaxExp is the largest leaf exponent.
	MaxExp   = 7
	limbBits = 128
)

// Claim is the witness and the public statement. The public inputs come first and in the order
// the on-chain verifier builds them.
type Claim struct {
	Root          frontend.Variable `gnark:",public"`
	NullifierHash frontend.Variable `gnark:",public"`
	Scope         frontend.Variable `gnark:",public"`
	RecipientHi   frontend.Variable `gnark:",public"`
	RecipientLo   frontend.Variable `gnark:",public"`
	Exp           frontend.Variable `gnark:",public"`
	MaxFee        frontend.Variable `gnark:",public"`

	Nullifier frontend.Variable
	Trapdoor  frontend.Variable
	// Path holds the siblings from the leaf up; Bits[k] is 1 when the node at level k is the
	// right child (the bits of the leaf index, least significant first).
	Path [Depth]frontend.Variable
	Bits [Depth]frontend.Variable
}

// PublicNames lists the public inputs in verifier order.
func PublicNames() []string {
	return []string{"Root", "NullifierHash", "Scope", "RecipientHi", "RecipientLo", "Exp", "MaxFee"}
}

// Define constrains the claim.
func (c *Claim) Define(api frontend.API) error {
	api.AssertIsDifferent(c.Nullifier, 0)
	api.AssertIsDifferent(c.Trapdoor, 0)

	bits.ToBinary(api, c.Exp, bits.WithNbDigits(3))

	inner := poseidon.Hash(api, c.Nullifier, c.Trapdoor)
	node := poseidon.Hash(api, inner, c.Exp)
	for k := 0; k < Depth; k++ {
		api.AssertIsBoolean(c.Bits[k])
		left := api.Select(c.Bits[k], c.Path[k], node)
		right := api.Select(c.Bits[k], node, c.Path[k])
		node = poseidon.Hash(api, left, right)
	}
	api.AssertIsEqual(node, c.Root)
	api.AssertIsEqual(poseidon.Hash(api, c.Nullifier, c.Scope), c.NullifierHash)

	for _, v := range []frontend.Variable{c.RecipientHi, c.RecipientLo, c.MaxFee} {
		bits.ToBinary(api, v, bits.WithNbDigits(limbBits))
	}
	return nil
}
