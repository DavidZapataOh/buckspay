package circuit

import (
	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/std/math/emulated"
	"github.com/consensys/gnark/std/math/uints"
	"github.com/consensys/gnark/std/signature/ecdsa"
)

// Counts splits the constraints of the circuit: the P-256 work, the SHA-256 work and the rest.
type Counts struct{ Total, P256, SHA256, Rules int }

// signatureWork is the P-256 part of Message on its own: the signature check and one more
// decompressed key.
type signatureWork struct {
	Digest [32]uints.U8
	Signer [33]uints.U8
	Owner0 [33]uints.U8
	Sig    ecdsa.Signature[emulated.P256Fr]
}

func (c *signatureWork) Define(api frontend.API) error {
	e, err := newEnv(api)
	if err != nil {
		return err
	}
	msg := e.fr.FromBits(e.bitsLSB(e.values(c.Digest[:]))...)
	e.verifySignature(msg, &c.Sig, e.values(c.Signer[:]))
	owner := e.values(c.Owner0[:])
	e.decompress(owner[0], owner[1:], nil)
	return nil
}

// hashWork is the SHA-256 part of Message on its own: the body, the envelope and the scope hash.
type hashWork struct {
	Body   [MaxBody]uints.U8
	Length frontend.Variable
	Domain [32]uints.U8
	Slot   [32]uints.U8
	Owner0 [33]uints.U8
}

func (c *hashWork) Define(api frontend.API) error {
	e, err := newEnv(api)
	if err != nil {
		return err
	}
	content := e.sha(c.Body[:], c.Length, Spend1BodyLen)
	envelope := append(append(append([]uints.U8{}, c.Domain[:]...), c.Slot[:]...), content...)
	e.sha(envelope, nil, 0)
	e.scopeHash(e.values(c.Owner0[:]))
	return nil
}

// Count compiles the circuit and its two heavy parts and reports their constraint counts.
func Count() (Counts, error) {
	n := func(c frontend.Circuit) (int, error) {
		ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, c)
		if err != nil {
			return 0, err
		}
		return ccs.GetNbConstraints(), nil
	}
	var out Counts
	var err error
	if out.Total, err = n(&Message{}); err != nil {
		return out, err
	}
	if out.P256, err = n(&signatureWork{}); err != nil {
		return out, err
	}
	if out.SHA256, err = n(&hashWork{}); err != nil {
		return out, err
	}
	out.Rules = out.Total - out.P256 - out.SHA256
	return out, nil
}
