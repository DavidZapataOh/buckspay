package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/consensys/gnark/backend"
	"github.com/consensys/gnark/backend/groth16"
	groth16bn254 "github.com/consensys/gnark/backend/groth16/bn254"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"

	"github.com/DavidZapataOh/buckspay/prover/circuit"
	"github.com/DavidZapataOh/buckspay/prover/proofenc"
	"github.com/DavidZapataOh/buckspay/prover/witness"
)

// proofJSON is one proof as the program reads it: the raw and the compressed point layouts of the
// alt_bn128 syscalls, the public inputs as 32 big-endian bytes, and the verdict of gnark's own verifier.
type proofJSON struct {
	Raw          string                    `json:"raw"`
	Compressed   string                    `json:"compressed"`
	Public       [circuit.NumPublic]string `json:"public"`
	GnarkAccepts bool                      `json:"gnark_accepts"`
}

type caseJSON struct {
	Name   string      `json:"name"`
	Proofs []proofJSON `json:"proofs"`
}

type proofsJSON struct {
	VKSHA256 string     `json:"vk_sha256"`
	Cases    []caseJSON `json:"cases"`
}

type prover struct {
	ccs constraint.ConstraintSystem
	pk  groth16.ProvingKey
	vk  groth16.VerifyingKey
	sum string
}

func loadProver(dir string) (*prover, error) {
	ccs, err := loadCCS(filepath.Join(dir, "ccs.bin"))
	if err != nil {
		return nil, err
	}
	pk := groth16.NewProvingKey(ecc.BN254)
	f, err := os.Open(filepath.Join(dir, "pk.dump"))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if err := pk.ReadDump(bufio.NewReaderSize(f, 1<<20)); err != nil {
		return nil, err
	}
	vk := groth16.NewVerifyingKey(ecc.BN254)
	if err := readFile(filepath.Join(dir, "vk.bin"), vk); err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(filepath.Join(dir, "vk.bin"))
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(raw)
	return &prover{ccs: ccs, pk: pk, vk: vk, sum: hex.EncodeToString(sum[:])}, nil
}

func (p *prover) prove(c *witness.Chain, i int, sha bool) (groth16.Proof, witness.Public10, error) {
	var pub witness.Public10
	a, err := witness.Assign(c, i)
	if err != nil {
		return nil, pub, err
	}
	full, err := frontend.NewWitness(a, ecc.BN254.ScalarField())
	if err != nil {
		return nil, pub, err
	}
	var opts []backend.ProverOption
	if sha {
		opts = append(opts, backend.WithProverHashToFieldFunction(sha256.New()))
	}
	proof, err := groth16.Prove(p.ccs, p.pk, full, opts...)
	if err != nil {
		return nil, pub, err
	}
	pub, err = witness.Public(c, i)
	return proof, pub, err
}

// accepts is the verdict of gnark's verifier with the SHA-256 hash to field the circuit uses.
func (p *prover) accepts(proof groth16.Proof, pub witness.Public10) bool {
	vals := make([]frontend.Variable, len(pub))
	for k := range pub {
		vals[k] = pub[k]
	}
	w, err := frontend.NewWitness(&circuit.Message{
		E: [2]frontend.Variable{vals[0], vals[1]}, Ctrl: vals[2], SIn: vals[3], SOut: vals[4],
		A: [2]frontend.Variable{vals[5], vals[6]}, B: [2]frontend.Variable{vals[7], vals[8]}, Amt: vals[9],
	}, ecc.BN254.ScalarField(), frontend.PublicOnly())
	if err != nil {
		return false
	}
	return groth16.Verify(proof, p.vk, w, backend.WithVerifierHashToFieldFunction(sha256.New())) == nil
}

func be32(x *big.Int) string {
	b := make([]byte, 32)
	x.FillBytes(b)
	return hex.EncodeToString(b)
}

func encode(proof groth16.Proof, pub witness.Public10, ok bool) (proofJSON, error) {
	p, good := proof.(*groth16bn254.Proof)
	if !good || len(p.Commitments) != 1 {
		return proofJSON{}, errors.New("not a BN254 proof with one commitment")
	}
	comp, err := proofenc.Compress(proof)
	if err != nil {
		return proofJSON{}, err
	}
	var raw []byte
	for _, q := range []*bn254.G1Affine{&p.Ar} {
		r := q.RawBytes()
		raw = append(raw, r[:]...)
	}
	rb := p.Bs.RawBytes()
	raw = append(raw, rb[:]...)
	for _, q := range []*bn254.G1Affine{&p.Krs, &p.Commitments[0], &p.CommitmentPok} {
		r := q.RawBytes()
		raw = append(raw, r[:]...)
	}
	out := proofJSON{Raw: hex.EncodeToString(raw), Compressed: hex.EncodeToString(comp), GnarkAccepts: ok}
	for k := range pub {
		out.Public[k] = be32(pub[k])
	}
	return out, nil
}

func writeProofs(path string, v proofsJSON) error {
	return writeJSON(path, v)
}

// proveBatch proves every message of the chains of vectors-format files, a file or a directory of
// them, and writes the proofs. Chains already in the output file are kept, not proved again.
func proveBatch(args []string) error {
	var dir, in, out string
	if _, err := flags("prove-batch", args, func(fs *flag.FlagSet) {
		fs.StringVar(&dir, "keys", "", "directory written by a setup")
		fs.StringVar(&in, "in", "", "chains, in the format of vectors.json: a file or a directory of files")
		fs.StringVar(&out, "out", "", "proofs file")
	}); err != nil {
		return err
	}
	files := []string{in}
	if info, err := os.Stat(in); err == nil && info.IsDir() {
		var err error
		if files, err = filepath.Glob(filepath.Join(in, "*.json")); err != nil {
			return err
		}
	}
	p, err := loadProver(dir)
	if err != nil {
		return err
	}
	res := proofsJSON{VKSHA256: p.sum}
	known := map[string]bool{}
	if raw, err := os.ReadFile(out); err == nil {
		if err := json.Unmarshal(raw, &res); err != nil {
			return err
		}
		if res.VKSHA256 != p.sum {
			return fmt.Errorf("%s holds proofs of key %s, not %s", out, res.VKSHA256, p.sum)
		}
		for _, c := range res.Cases {
			known[c.Name] = true
		}
	}
	seen := map[string]proofJSON{}
	for _, file := range files {
		v, err := loadVectors(file)
		if err != nil {
			return err
		}
		for ci := range v.Valid {
			if known[v.Valid[ci].Name] {
				continue
			}
			chain := v.Valid[ci].Chain()
			cj := caseJSON{Name: v.Valid[ci].Name}
			for i := range chain.Messages {
				pub, err := witness.Public(chain, i)
				if err != nil {
					return err
				}
				key := fmt.Sprint(pub)
				if done, ok := seen[key]; ok {
					cj.Proofs = append(cj.Proofs, done)
					continue
				}
				start := time.Now()
				proof, pub, err := p.prove(chain, i, true)
				if err != nil {
					return fmt.Errorf("%s/%d: %w", v.Valid[ci].Name, i, err)
				}
				ok := p.accepts(proof, pub)
				if !ok {
					return fmt.Errorf("%s/%d: gnark rejects its own proof", v.Valid[ci].Name, i)
				}
				pj, err := encode(proof, pub, ok)
				if err != nil {
					return err
				}
				seen[key] = pj
				cj.Proofs = append(cj.Proofs, pj)
				fmt.Fprintf(os.Stderr, "%s/%d proved in %s\n", cj.Name[:12], i, time.Since(start).Round(time.Millisecond))
			}
			res.Cases = append(res.Cases, cj)
			known[cj.Name] = true
		}
	}
	return writeProofs(out, res)
}

// negativesJSON is a proof that gnark's verifier refuses, with the public inputs it is checked against.
type negativeJSON struct {
	Name         string                    `json:"name"`
	Raw          string                    `json:"raw"`
	Public       [circuit.NumPublic]string `json:"public"`
	GnarkAccepts bool                      `json:"gnark_accepts"`
}

// fixtures writes the proofs the verifier crate tests need: the sixteen-hop chain and the proofs
// that must be refused, each with the verdict of gnark.
func fixtures(args []string) error {
	var dir, vectors, out string
	if _, err := flags("fixtures", args, func(fs *flag.FlagSet) {
		fs.StringVar(&dir, "keys", "", "directory written by a setup")
		fs.StringVar(&vectors, "vectors", "", "vectors.json")
		fs.StringVar(&out, "out", "", "output directory")
	}); err != nil {
		return err
	}
	v, err := loadVectors(vectors)
	if err != nil {
		return err
	}
	p, err := loadProver(dir)
	if err != nil {
		return err
	}
	long := v.ByName("issue_plus_16")
	if long == nil {
		return errors.New("no chain issue_plus_16")
	}
	chain := long.Chain()
	res := proofsJSON{VKSHA256: p.sum}
	cj := caseJSON{Name: long.Name}
	var raws []groth16.Proof
	var pubs []witness.Public10
	for i := range chain.Messages {
		proof, pub, err := p.prove(chain, i, true)
		if err != nil {
			return err
		}
		ok := p.accepts(proof, pub)
		pj, err := encode(proof, pub, ok)
		if err != nil {
			return err
		}
		cj.Proofs = append(cj.Proofs, pj)
		raws, pubs = append(raws, proof), append(pubs, pub)
		fmt.Fprintf(os.Stderr, "chain16/%d proved, gnark accepts %v\n", i, ok)
	}
	res.Cases = []caseJSON{cj}
	if err := writeProofs(filepath.Join(out, "chain16.json"), res); err != nil {
		return err
	}

	var negatives []negativeJSON
	add := func(name string, proof groth16.Proof, pub witness.Public10) error {
		pj, err := encode(proof, pub, p.accepts(proof, pub))
		if err != nil {
			return err
		}
		negatives = append(negatives, negativeJSON{Name: name, Raw: pj.Raw, Public: pj.Public, GnarkAccepts: pj.GnarkAccepts})
		return nil
	}
	const target, other = 1, 2
	for j := 0; j < circuit.NumPublic; j++ {
		altered := pubs[target]
		altered[j] = new(big.Int).Add(altered[j], big.NewInt(1))
		if err := add(fmt.Sprintf("public_%d", j), raws[target], altered); err != nil {
			return err
		}
	}
	for _, field := range []string{"a", "b", "c", "d", "pok"} {
		base := *raws[target].(*groth16bn254.Proof)
		base.Commitments = append([]bn254.G1Affine(nil), base.Commitments...)
		donor := raws[other].(*groth16bn254.Proof)
		switch field {
		case "a":
			base.Ar = donor.Ar
		case "b":
			base.Bs = donor.Bs
		case "c":
			base.Krs = donor.Krs
		case "d":
			base.Commitments[0] = donor.Commitments[0]
		case "pok":
			base.CommitmentPok = donor.CommitmentPok
		}
		if err := add("swapped_"+field, &base, pubs[target]); err != nil {
			return err
		}
	}
	proof, pub, err := p.prove(chain, target, false)
	if err != nil {
		return err
	}
	if err := add("default_hash_to_field", proof, pub); err != nil {
		return err
	}
	return writeJSON(filepath.Join(out, "negatives.json"), negatives)
}
