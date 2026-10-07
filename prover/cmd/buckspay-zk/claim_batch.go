package main

import (
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"math/big"
	"os"
	"strings"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/frontend"

	"github.com/DavidZapataOh/buckspay/prover/claim"
	"github.com/DavidZapataOh/buckspay/prover/proofenc"
)

// claimRequest is one claim the program tests need proved: the leaves of the tree as the program
// built them, which one is opened, and the values the proof binds.
type claimRequest struct {
	Leaves    []string `json:"leaves"`
	Index     int      `json:"index"`
	Nullifier string   `json:"nullifier"`
	Trapdoor  string   `json:"trapdoor"`
	Exp       uint8    `json:"exp"`
	Scope     string   `json:"scope"`
	Recipient string   `json:"recipient"`
	MaxFee    uint64   `json:"max_fee"`
}

type provedClaim struct {
	Key        string                  `json:"key"`
	Raw        string                  `json:"raw"`
	Compressed string                  `json:"compressed"`
	Public     [claim.NumPublic]string `json:"public"`
}

type provedClaims struct {
	VKSHA256 string        `json:"vk_sha256"`
	Claims   []provedClaim `json:"claims"`
}

func decode32(s string) ([32]byte, error) {
	var out [32]byte
	b, err := hex.DecodeString(s)
	if err != nil || len(b) != 32 {
		return out, fmt.Errorf("want 32 hex bytes, got %q", s)
	}
	copy(out[:], b)
	return out, nil
}

// claimProveBatch proves every request of a file under the keys in --keys. The key of a proof is
// its public inputs concatenated, which is what the program tests look it up by.
func claimProveBatch(args []string) error {
	var dir, in, out string
	if _, err := flags("claim-prove-batch", args, func(fs *flag.FlagSet) {
		fs.StringVar(&dir, "keys", "", "claim key directory")
		fs.StringVar(&in, "in", "", "requests file")
		fs.StringVar(&out, "out", "", "output file")
	}); err != nil {
		return err
	}
	if dir == "" || in == "" || out == "" {
		return fmt.Errorf("usage: buckspay-zk claim-prove-batch --keys DIR --in FILE --out FILE")
	}
	raw, err := os.ReadFile(in)
	if err != nil {
		return err
	}
	var requests []claimRequest
	if err := json.Unmarshal(raw, &requests); err != nil {
		return err
	}
	p, err := loadProver(dir)
	if err != nil {
		return err
	}
	res := provedClaims{VKSHA256: p.sum}
	for n, r := range requests {
		item, err := p.proveRequest(r)
		if err != nil {
			return fmt.Errorf("request %d: %w", n, err)
		}
		res.Claims = append(res.Claims, item)
	}
	return writeJSON(out, res)
}

func (p *prover) proveRequest(r claimRequest) (provedClaim, error) {
	tree := &claim.Tree{}
	for _, l := range r.Leaves {
		b, err := decode32(l)
		if err != nil {
			return provedClaim{}, err
		}
		e, err := claim.FromCanonical(b)
		if err != nil {
			return provedClaim{}, err
		}
		tree.Leaves = append(tree.Leaves, e)
	}
	in := claim.Inputs{Exp: r.Exp, MaxFee: new(big.Int).SetUint64(r.MaxFee), LeafIndex: r.Index}
	for dst, src := range map[*[32]byte]string{&in.Nullifier: r.Nullifier, &in.Trapdoor: r.Trapdoor, &in.Scope: r.Scope, &in.Recipient: r.Recipient} {
		b, err := decode32(src)
		if err != nil {
			return provedClaim{}, err
		}
		*dst = b
	}
	c, err := claim.Assign(tree, in)
	if err != nil {
		return provedClaim{}, err
	}
	w, err := frontend.NewWitness(c, ecc.BN254.ScalarField())
	if err != nil {
		return provedClaim{}, err
	}
	proof, err := groth16.Prove(p.ccs, p.pk, w)
	if err != nil {
		return provedClaim{}, err
	}
	pub, err := w.Public()
	if err != nil {
		return provedClaim{}, err
	}
	if err := groth16.Verify(proof, p.vk, pub); err != nil {
		return provedClaim{}, err
	}
	rawProof, err := proofenc.RawPlain(proof)
	if err != nil {
		return provedClaim{}, err
	}
	comp, err := proofenc.CompressPlain(proof)
	if err != nil {
		return provedClaim{}, err
	}
	item := provedClaim{Raw: hex.EncodeToString(rawProof), Compressed: hex.EncodeToString(comp)}
	var key strings.Builder
	for k, v := range pub.Vector().(fr.Vector) {
		item.Public[k] = hex32(v)
		key.WriteString(item.Public[k])
	}
	item.Key = key.String()
	return item, nil
}
