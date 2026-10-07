// Package proofenc writes a gnark Groth16 proof in the layouts the Solana verifier reads.
package proofenc

import (
	"errors"

	"github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/consensys/gnark/backend/groth16"
	groth16bn254 "github.com/consensys/gnark/backend/groth16/bn254"
)

// CompressedLen is A 32 | B 64 | C 32 | D 32 | Pok 32.
const CompressedLen = 192

// ArkFlags rewrites the flag bits of a gnark compressed point into those of the compression
// syscalls: gnark marks the smaller y 0b10, the larger 0b11 and infinity 0b01; the syscalls leave
// the smaller y unmarked, mark the larger 0b10 and infinity 0b01.
func ArkFlags(b []byte) []byte {
	top := b[0] & 0xC0
	b[0] &^= 0xC0
	switch top {
	case 0xC0:
		b[0] |= 0x80
	case 0x40:
		b[0] |= 0x40
	}
	return b
}

// GnarkFlags is the inverse of ArkFlags.
func GnarkFlags(b []byte) []byte {
	top := b[0] & 0xC0
	b[0] &^= 0xC0
	switch top {
	case 0x00:
		b[0] |= 0x80
	case 0x80:
		b[0] |= 0xC0
	case 0x40:
		b[0] |= 0x40
	}
	return b
}

func parts(proof groth16.Proof) (*groth16bn254.Proof, error) {
	p, ok := proof.(*groth16bn254.Proof)
	if !ok || len(p.Commitments) != 1 {
		return nil, errors.New("not a BN254 proof with one commitment")
	}
	return p, nil
}

// Compress returns the compressed layout of a BN254 proof with one commitment.
func Compress(proof groth16.Proof) ([]byte, error) {
	p, err := parts(proof)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, CompressedLen)
	for _, q := range []*bn254.G1Affine{&p.Ar} {
		c := q.Bytes()
		out = append(out, ArkFlags(c[:])...)
	}
	c := p.Bs.Bytes()
	out = append(out, ArkFlags(c[:])...)
	for _, q := range []*bn254.G1Affine{&p.Krs, &p.Commitments[0], &p.CommitmentPok} {
		c := q.Bytes()
		out = append(out, ArkFlags(c[:])...)
	}
	return out, nil
}
