package ceremony_test

import (
	"bytes"
	"crypto/sha256"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend"
	"github.com/consensys/gnark/backend/groth16"
	cs_bn254 "github.com/consensys/gnark/constraint/bn254"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"

	"github.com/DavidZapataOh/buckspay/prover/ceremony"
)

type committed struct {
	X frontend.Variable
	Y frontend.Variable `gnark:",public"`
}

func (c *committed) Define(api frontend.API) error {
	cm, err := api.(frontend.Committer).Commit(c.X)
	if err != nil {
		return err
	}
	api.AssertIsDifferent(cm, 0)
	api.AssertIsEqual(api.Mul(c.X, c.X), c.Y)
	return nil
}

func keys(t *testing.T, beacon []byte, tamper bool) (*cs_bn254.R1CS, groth16.ProvingKey, groth16.VerifyingKey, error) {
	t.Helper()
	ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &committed{})
	if err != nil {
		t.Fatal(err)
	}
	r := ccs.(*cs_bn254.R1CS)
	p0 := ceremony.Init1Size(8)
	p1 := ceremony.Contribute1(p0)
	p2 := ceremony.Contribute1(p1)
	srs, err := ceremony.Seal1(8, beacon, p1, p2)
	if err != nil {
		t.Fatal(err)
	}
	q0, err := ceremony.Init2(r, &srs)
	if err != nil {
		t.Fatal(err)
	}
	q1 := ceremony.Contribute2(q0)
	q2 := ceremony.Contribute2(q1)
	if tamper {
		q2 = ceremony.Contribute2(q0) // skips q1: the chain no longer links
	}
	pk, vk, err := ceremony.Seal2(r, &srs, beacon, q1, q2)
	return r, pk, vk, err
}

func TestCeremonyKeysProveAndVerifyACommittedCircuit(t *testing.T) {
	r, pk, vk, err := keys(t, []byte("beacon"), false)
	if err != nil {
		t.Fatal(err)
	}
	w, _ := frontend.NewWitness(&committed{X: 3, Y: 9}, ecc.BN254.ScalarField())
	proof, err := groth16.Prove(r, pk, w, backend.WithProverHashToFieldFunction(sha256.New()))
	if err != nil {
		t.Fatal(err)
	}
	pub, _ := w.Public()
	if err := groth16.Verify(proof, vk, pub, backend.WithVerifierHashToFieldFunction(sha256.New())); err != nil {
		t.Fatal(err)
	}
	bad, _ := frontend.NewWitness(&committed{Y: 10}, ecc.BN254.ScalarField(), frontend.PublicOnly())
	if groth16.Verify(proof, vk, bad, backend.WithVerifierHashToFieldFunction(sha256.New())) == nil {
		t.Fatal("a proof must not verify against other public inputs")
	}
}

func TestBrokenContributionChainIsRefused(t *testing.T) {
	if _, _, _, err := keys(t, []byte("beacon"), true); err == nil {
		t.Fatal("a phase 2 chain with a missing link must not seal")
	}
}

func TestBeaconChangesTheKey(t *testing.T) {
	_, _, a, _ := keys(t, []byte("one"), false)
	_, _, b, _ := keys(t, []byte("two"), false)
	var ea, eb bytes.Buffer
	_, _ = a.WriteTo(&ea)
	_, _ = b.WriteTo(&eb)
	if bytes.Equal(ea.Bytes(), eb.Bytes()) {
		t.Fatal("different beacons must give different verifying keys")
	}
}

func TestPhase1ChainWithAMissingLinkIsRefused(t *testing.T) {
	p0 := ceremony.Init1Size(4)
	p1 := ceremony.Contribute1(p0)
	p2 := ceremony.Contribute1(p1)
	p2b := ceremony.Contribute1(p0)
	if _, err := ceremony.Seal1(4, []byte("b"), p1, p2b); err == nil {
		t.Fatal("a phase 1 chain whose second contribution does not follow the first must not seal")
	}
	if _, err := ceremony.Seal1(4, []byte("b"), p1, p2); err != nil {
		t.Fatal(err)
	}
}

func TestContributeDoesNotModifyItsInput(t *testing.T) {
	p0 := ceremony.Init1Size(4)
	before := ceremony.ContributionHash(p0)
	ceremony.Contribute1(p0)
	if ceremony.ContributionHash(p0) != before {
		t.Fatal("Contribute1 modified the previous contribution")
	}
}
