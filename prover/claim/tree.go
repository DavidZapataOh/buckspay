package claim

import (
	"errors"
	"fmt"
	"math/big"

	"github.com/consensys/gnark-crypto/ecc/bn254/fr"

	"github.com/DavidZapataOh/buckspay/prover/poseidon"
)

// ErrNonCanonical is returned for 32 bytes that encode a value of r or more. The Poseidon gadget
// would reduce such a value modulo r while the syscall refuses it, so it never reaches a witness.
var ErrNonCanonical = errors.New("value is not below the BN254 scalar field modulus")

// FromCanonical reads 32 big-endian bytes as a field element and refuses values of r or more.
func FromCanonical(b [32]byte) (fr.Element, error) {
	var e fr.Element
	if err := e.SetBytesCanonical(b[:]); err != nil {
		return e, ErrNonCanonical
	}
	return e, nil
}

// Bytes32 is the 32-byte big-endian form of a field element.
func Bytes32(e fr.Element) [32]byte { return e.Bytes() }

// Inner is Poseidon(nullifier, trapdoor), the secret-derived part of a leaf.
func Inner(nullifier, trapdoor fr.Element) fr.Element { return poseidon.Native(nullifier, trapdoor) }

// Leaf is Poseidon(inner, exp).
func Leaf(inner fr.Element, exp uint8) fr.Element {
	var e fr.Element
	e.SetUint64(uint64(exp))
	return poseidon.Native(inner, e)
}

// NullifierHash is Poseidon(nullifier, scope).
func NullifierHash(nullifier, scope fr.Element) fr.Element { return poseidon.Native(nullifier, scope) }

// SplitRecipient returns the 128-bit limbs of a recipient: the first and the last 16 bytes.
func SplitRecipient(recipient [32]byte) (hi, lo fr.Element) {
	hi.SetBytes(recipient[:16])
	lo.SetBytes(recipient[16:])
	return
}

// Tree is an append-only Poseidon Merkle tree of depth Depth whose empty leaf is zero and whose
// empty node of level k+1 is Poseidon(z_k, z_k).
type Tree struct{ Leaves []fr.Element }

var zeros = func() (z [Depth + 1]fr.Element) {
	for k := 0; k < Depth; k++ {
		z[k+1] = poseidon.Native(z[k], z[k])
	}
	return
}()

// Zero is the empty node of the given level.
func Zero(level int) fr.Element { return zeros[level] }

func (t *Tree) levels() [][]fr.Element {
	out := make([][]fr.Element, Depth+1)
	out[0] = t.Leaves
	for k := 0; k < Depth; k++ {
		cur := out[k]
		next := make([]fr.Element, (len(cur)+1)/2)
		for i := range next {
			right := zeros[k]
			if 2*i+1 < len(cur) {
				right = cur[2*i+1]
			}
			next[i] = poseidon.Native(cur[2*i], right)
		}
		out[k+1] = next
	}
	return out
}

// Root is the root of the tree.
func (t *Tree) Root() fr.Element {
	top := t.levels()[Depth]
	if len(top) == 0 {
		return zeros[Depth]
	}
	return top[0]
}

// Path returns the siblings of the leaf at index and its position bits, from the leaf up.
func (t *Tree) Path(index int) (siblings [Depth]fr.Element, pos [Depth]uint8, err error) {
	if index < 0 || index >= 1<<Depth {
		return siblings, pos, fmt.Errorf("leaf index %d outside the tree", index)
	}
	lv := t.levels()
	for k := 0; k < Depth; k++ {
		sib := index>>k ^ 1
		siblings[k] = zeros[k]
		if sib < len(lv[k]) {
			siblings[k] = lv[k][sib]
		}
		pos[k] = uint8(index >> k & 1)
	}
	return
}

// Inputs are the claim values as the phone stores and sends them: 32-byte big-endian integers.
type Inputs struct {
	Nullifier, Trapdoor [32]byte
	Exp                 uint8
	Scope               [32]byte
	Recipient           [32]byte
	MaxFee              *big.Int
	LeafIndex           int
}

// Assign builds the witness of a claim on the leaf at in.LeafIndex of tree, which must hold the
// leaf the secrets and the exponent derive. Every 32-byte input must be canonical.
func Assign(tree *Tree, in Inputs) (*Claim, error) {
	nullifier, err := FromCanonical(in.Nullifier)
	if err != nil {
		return nil, fmt.Errorf("nullifier: %w", err)
	}
	trapdoor, err := FromCanonical(in.Trapdoor)
	if err != nil {
		return nil, fmt.Errorf("trapdoor: %w", err)
	}
	scope, err := FromCanonical(in.Scope)
	if err != nil {
		return nil, fmt.Errorf("scope: %w", err)
	}
	if in.Exp > MaxExp {
		return nil, fmt.Errorf("exponent %d above %d", in.Exp, MaxExp)
	}
	if in.MaxFee == nil || in.MaxFee.Sign() < 0 || in.MaxFee.BitLen() > limbBits {
		return nil, errors.New("max fee outside 0..2^128")
	}
	siblings, pos, err := tree.Path(in.LeafIndex)
	if err != nil {
		return nil, err
	}
	if leaf := Leaf(Inner(nullifier, trapdoor), in.Exp); in.LeafIndex >= len(tree.Leaves) || !tree.Leaves[in.LeafIndex].Equal(&leaf) {
		return nil, errors.New("the tree does not hold this leaf at this index")
	}
	hi, lo := SplitRecipient(in.Recipient)
	c := &Claim{
		Nullifier: nullifier, Trapdoor: trapdoor, Scope: scope,
		Root:          tree.Root(),
		NullifierHash: NullifierHash(nullifier, scope),
		RecipientHi:   hi, RecipientLo: lo,
		Exp:    uint64(in.Exp),
		MaxFee: new(big.Int).Set(in.MaxFee),
	}
	for k := 0; k < Depth; k++ {
		c.Path[k] = siblings[k]
		c.Bits[k] = uint64(pos[k])
	}
	return c, nil
}
