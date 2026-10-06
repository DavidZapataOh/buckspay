// Package ceremony wraps gnark's two-phase Groth16 setup for BN254 (a Powers of Tau phase and a
// circuit-specific phase, each a chain of contributions closed by a public beacon).
//
// Every contribution samples its secret inside gnark and keeps nothing; soundness holds as long as
// one contributor of each phase destroyed its randomness.
package ceremony

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"

	"github.com/consensys/gnark/backend/groth16"
	mpcsetup "github.com/consensys/gnark/backend/groth16/bn254/mpcsetup"
	cs_bn254 "github.com/consensys/gnark/constraint/bn254"
)

// Log2Domain is the log2 of the FFT domain the production keys are made for.
const Log2Domain = 20

// Init1 starts phase 1 for the production domain.
func Init1() *mpcsetup.Phase1 { return Init1Size(Log2Domain) }

// Init1Size starts phase 1 for a domain of 2^log2 constraints.
func Init1Size(log2 uint8) *mpcsetup.Phase1 { return mpcsetup.NewPhase1(1 << log2) }

// Contribute1 returns the contribution that follows prev; prev is not modified.
func Contribute1(prev *mpcsetup.Phase1) *mpcsetup.Phase1 {
	next := clone(prev, new(mpcsetup.Phase1))
	next.Contribute()
	return next
}

// Seal1 verifies every contribution of phase 1 in order, closes the chain with the beacon and
// returns the parameters usable by any circuit that fits the domain 2^log2. The last
// contribution is modified.
func Seal1(log2 uint8, beacon []byte, cs ...*mpcsetup.Phase1) (mpcsetup.SrsCommons, error) {
	return mpcsetup.VerifyPhase1(1<<log2, beacon, cs...)
}

// Init2 starts phase 2 for ccs on top of the phase 1 parameters.
func Init2(ccs *cs_bn254.R1CS, srs *mpcsetup.SrsCommons) (*mpcsetup.Phase2, error) {
	p := new(mpcsetup.Phase2)
	p.Initialize(ccs, srs)
	return p, nil
}

// Contribute2 returns the contribution that follows prev; prev is not modified.
func Contribute2(prev *mpcsetup.Phase2) *mpcsetup.Phase2 {
	next := clone(prev, new(mpcsetup.Phase2))
	next.Contribute()
	return next
}

// Seal2 verifies every contribution of phase 2 in order, closes the chain with the beacon and
// returns the proving and verifying keys. Anyone can repeat it from the published files and get
// the same keys. The last contribution is modified.
func Seal2(ccs *cs_bn254.R1CS, srs *mpcsetup.SrsCommons, beacon []byte, cs ...*mpcsetup.Phase2) (groth16.ProvingKey, groth16.VerifyingKey, error) {
	return mpcsetup.VerifyPhase2(ccs, srs, beacon, cs...)
}

// ContributionHash is the SHA-256 of the encoding of a contribution, as listed in the manifest.
func ContributionHash(w io.WriterTo) string {
	h := sha256.New()
	if _, err := w.WriteTo(h); err != nil {
		panic(err)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// Beacon is the randomness that closes a phase: the SHA-256 of a Solana blockhash chosen after the
// last contribution.
func Beacon(blockhash [32]byte) []byte {
	sum := sha256.Sum256(blockhash[:])
	return sum[:]
}

type codec interface {
	io.WriterTo
	io.ReaderFrom
}

func clone[T codec](from, to T) T {
	var buf bytes.Buffer
	if _, err := from.WriteTo(&buf); err != nil {
		panic(err)
	}
	if _, err := to.ReadFrom(&buf); err != nil {
		panic(err)
	}
	return to
}
