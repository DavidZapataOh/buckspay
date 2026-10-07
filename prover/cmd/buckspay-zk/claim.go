package main

import (
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"math/big"
	"os"
	"time"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/frontend"

	"github.com/DavidZapataOh/buckspay/prover/claim"
	"github.com/DavidZapataOh/buckspay/prover/proofenc"
)

func hex32(e fr.Element) string {
	b := claim.Bytes32(e)
	return hex.EncodeToString(b[:])
}

func hexBytes(b [32]byte) string { return hex.EncodeToString(b[:]) }

// sample is the deterministic claim material of leaf i: nothing here is secret.
func sample(i int) claim.Inputs {
	field := func(label string) [32]byte {
		var e fr.Element
		e.SetBigInt(new(big.Int).SetBytes([]byte(fmt.Sprintf("buckspay/claim-vectors/%s/%d", label, i))))
		return claim.Bytes32(e)
	}
	return claim.Inputs{
		Nullifier: field("nullifier"), Trapdoor: field("trapdoor"), Exp: uint8(i % (claim.MaxExp + 1)),
		Scope: field("scope"), Recipient: field("recipient"), MaxFee: big.NewInt(900_000), LeafIndex: i,
	}
}

func sampleTree(n int) (*claim.Tree, []claim.Inputs, error) {
	tree := &claim.Tree{}
	ins := make([]claim.Inputs, n)
	for i := range ins {
		ins[i] = sample(i)
		nf, err := claim.FromCanonical(ins[i].Nullifier)
		if err != nil {
			return nil, nil, err
		}
		tf, err := claim.FromCanonical(ins[i].Trapdoor)
		if err != nil {
			return nil, nil, err
		}
		tree.Leaves = append(tree.Leaves, claim.Leaf(claim.Inner(nf, tf), ins[i].Exp))
	}
	return tree, ins, nil
}

type derivationJSON struct {
	Nullifier     string `json:"nullifier"`
	Trapdoor      string `json:"trapdoor"`
	Exp           uint8  `json:"exp"`
	Scope         string `json:"scope"`
	Inner         string `json:"inner"`
	Leaf          string `json:"leaf"`
	NullifierHash string `json:"nullifier_hash"`
}

type pathJSON struct {
	Index    int      `json:"index"`
	Siblings []string `json:"siblings"`
}

type vectorsJSON struct {
	Depth       int              `json:"depth"`
	Zeros       []string         `json:"zeros"`
	Derivations []derivationJSON `json:"derivations"`
	Leaves      []string         `json:"leaves"`
	Root        string           `json:"root"`
	Paths       []pathJSON       `json:"paths"`
}

func claimVectorsJSON() ([]byte, error) {
	tree, ins, err := sampleTree(9)
	if err != nil {
		return nil, err
	}
	out := vectorsJSON{Depth: claim.Depth, Root: hex32(tree.Root())}
	for k := 0; k <= claim.Depth; k++ {
		out.Zeros = append(out.Zeros, hex32(claim.Zero(k)))
	}
	for _, in := range ins {
		n, _ := claim.FromCanonical(in.Nullifier)
		t, _ := claim.FromCanonical(in.Trapdoor)
		s, _ := claim.FromCanonical(in.Scope)
		inner := claim.Inner(n, t)
		out.Derivations = append(out.Derivations, derivationJSON{
			Nullifier: hexBytes(in.Nullifier), Trapdoor: hexBytes(in.Trapdoor), Exp: in.Exp, Scope: hexBytes(in.Scope),
			Inner: hex32(inner), Leaf: hex32(claim.Leaf(inner, in.Exp)), NullifierHash: hex32(claim.NullifierHash(n, s)),
		})
	}
	for _, l := range tree.Leaves {
		out.Leaves = append(out.Leaves, hex32(l))
	}
	for _, i := range []int{0, 5, 8} {
		sib, _, err := tree.Path(i)
		if err != nil {
			return nil, err
		}
		p := pathJSON{Index: i}
		for _, s := range sib {
			p.Siblings = append(p.Siblings, hex32(s))
		}
		out.Paths = append(out.Paths, p)
	}
	raw, err := json.MarshalIndent(out, "", "  ")
	return append(raw, '\n'), err
}

func claimVectors(args []string) error {
	if _, err := flags("claim-vectors", args, func(*flag.FlagSet) {}); err != nil {
		return err
	}
	raw, err := claimVectorsJSON()
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(raw)
	return err
}

type claimProofJSON struct {
	LeafIndex  int                     `json:"leaf_index"`
	Raw        string                  `json:"raw"`
	Compressed string                  `json:"compressed"`
	Public     [claim.NumPublic]string `json:"public"`
}

type claimFixturesJSON struct {
	VKSHA256 string           `json:"vk_sha256"`
	Claims   []claimProofJSON `json:"claims"`
}

// claimFixtures proves claims of the sample tree under the keys in --keys and writes them with
// their public inputs, as the Solana verifier reads them. Proofs are randomised, so the file differs
// on every run.
func claimFixtures(args []string) error {
	var dir, out string
	if _, err := flags("claim-fixtures", args, func(fs *flag.FlagSet) {
		fs.StringVar(&dir, "keys", "", "claim key directory")
		fs.StringVar(&out, "out", "", "output file")
	}); err != nil {
		return err
	}
	if dir == "" || out == "" {
		return fmt.Errorf("usage: buckspay-zk claim-fixtures --keys DIR --out FILE")
	}
	p, err := loadProver(dir)
	if err != nil {
		return err
	}
	tree, ins, err := sampleTree(9)
	if err != nil {
		return err
	}
	res := claimFixturesJSON{VKSHA256: p.sum}
	for _, i := range []int{0, 1, 5, 8} {
		start := time.Now()
		c, err := claim.Assign(tree, ins[i])
		if err != nil {
			return err
		}
		w, err := frontend.NewWitness(c, ecc.BN254.ScalarField())
		if err != nil {
			return err
		}
		proof, err := groth16.Prove(p.ccs, p.pk, w)
		if err != nil {
			return err
		}
		pub, err := w.Public()
		if err != nil {
			return err
		}
		if err := groth16.Verify(proof, p.vk, pub); err != nil {
			return fmt.Errorf("leaf %d: %w", i, err)
		}
		fmt.Fprintf(os.Stderr, "leaf %d proved in %s, peak RSS %d MB\n", i, time.Since(start).Round(time.Millisecond), peakRSS())
		raw, err := proofenc.RawPlain(proof)
		if err != nil {
			return err
		}
		comp, err := proofenc.CompressPlain(proof)
		if err != nil {
			return err
		}
		item := claimProofJSON{LeafIndex: i, Raw: hex.EncodeToString(raw), Compressed: hex.EncodeToString(comp)}
		for k, v := range pub.Vector().(fr.Vector) {
			item.Public[k] = hex32(v)
		}
		res.Claims = append(res.Claims, item)
	}
	return writeJSON(out, res)
}
