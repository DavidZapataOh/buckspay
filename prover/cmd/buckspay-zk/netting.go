package main

import (
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/frontend"

	"github.com/DavidZapataOh/buckspay/prover/keys"
	"github.com/DavidZapataOh/buckspay/prover/netting"
	"github.com/DavidZapataOh/buckspay/prover/proofenc"
)

const nettingUsage = "usage: buckspay-zk netting setup --test-keys --out DIR | prove --keys DIR (--witness FILE | " +
	"--fixtures FILE --program ID...) | vectors"

func nettingCmd(args []string) error {
	if len(args) == 0 {
		return errors.New(nettingUsage)
	}
	switch args[0] {
	case "setup":
		return nettingSetup(args[1:])
	case "prove":
		return nettingProve(args[1:])
	case "vectors":
		raw, err := netting.VectorsJSON()
		if err != nil {
			return err
		}
		_, err = os.Stdout.Write(raw)
		return err
	}
	return errors.New(nettingUsage)
}

// nettingSetup runs the single-party setup of gnark for the netting circuit. Whoever runs it holds the trapdoor.
func nettingSetup(args []string) error {
	var out string
	var test bool
	if _, err := flags("netting setup", args, func(fs *flag.FlagSet) {
		fs.StringVar(&out, "out", "", "output directory")
		fs.BoolVar(&test, "test-keys", false, "confirm that the keys are throwaway test keys")
	}); err != nil {
		return err
	}
	if out == "" || !test {
		return errors.New("usage: buckspay-zk netting setup --test-keys --out DIR (production keys come from a ceremony)")
	}
	ccs, err := compile("netting")
	if err != nil {
		return err
	}
	start := time.Now()
	pk, vk, err := groth16.Setup(ccs)
	if err != nil {
		return err
	}
	took := time.Since(start)
	m, err := keys.Store(filepath.Clean(out), ccs, pk, vk, keys.Manifest{Test: true})
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "setup in %s, peak RSS %d MB\n", took.Round(time.Millisecond), peakRSS())
	info, err := os.Stat(filepath.Join(out, "pk.bin"))
	if err != nil {
		return err
	}
	fmt.Printf("constraints=%d pk_bytes=%d vk_sha256=%s\n", m.Constraints, info.Size(), m.VKSHA256)
	return nil
}

type nettingProof struct {
	Name       string                    `json:"name"`
	Statement  string                    `json:"statement"`
	Raw        string                    `json:"raw"`
	Compressed string                    `json:"compressed"`
	Public     [netting.NumPublic]string `json:"public"`
}

type nettingFixtures struct {
	VKSHA256 string         `json:"vk_sha256"`
	Cases    []nettingProof `json:"cases"`
}

func nettingProve(args []string) error {
	var dir, witnessFile, fixtures string
	var programs stringList
	if _, err := flags("netting prove", args, func(fs *flag.FlagSet) {
		fs.StringVar(&dir, "keys", "", "netting key directory")
		fs.StringVar(&witnessFile, "witness", "", "witness file (netting.EncodeWitness)")
		fs.StringVar(&fixtures, "fixtures", "", "write the named fixture set to this file")
		fs.Var(&programs, "program", "base58 program id the record addresses are ground for (repeatable)")
	}); err != nil {
		return err
	}
	if dir == "" || (witnessFile == "") == (fixtures == "") {
		return errors.New(nettingUsage)
	}
	p, err := loadProver(dir)
	if err != nil {
		return err
	}
	if witnessFile != "" {
		raw, err := os.ReadFile(witnessFile)
		if err != nil {
			return err
		}
		st, slots, err := netting.DecodeWitness(raw)
		if err != nil {
			return err
		}
		start := time.Now()
		proof, err := p.proveNetting(st, slots)
		if err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "proved and verified in %s, peak RSS %d MB\n", time.Since(start).Round(time.Millisecond), peakRSS())
		fmt.Println(proof.Raw)
		return nil
	}
	ids := make([][32]byte, 0, len(programs))
	for _, s := range programs {
		id, err := base58Decode32(s)
		if err != nil {
			return fmt.Errorf("--program %s: %w", s, err)
		}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return errors.New("--fixtures needs at least one --program")
	}
	set, err := fixtureSet(ids)
	if err != nil {
		return err
	}
	out := nettingFixtures{VKSHA256: p.sum}
	for _, f := range set {
		start := time.Now()
		proof, err := p.proveNetting(f.st, f.slots)
		if err != nil {
			return fmt.Errorf("%s: %w", f.name, err)
		}
		proof.Name = f.name
		out.Cases = append(out.Cases, proof)
		fmt.Fprintf(os.Stderr, "%s proved in %s\n", f.name, time.Since(start).Round(time.Millisecond))
	}
	return writeJSON(fixtures, out)
}

// proveNetting proves one netting and checks the proof with gnark's verifier before returning it.
func (p *prover) proveNetting(st netting.Statement, slots [netting.Slots]netting.WitnessSlot) (nettingProof, error) {
	var out nettingProof
	a, err := netting.Assign(st, slots)
	if err != nil {
		return out, err
	}
	full, err := frontend.NewWitness(a, ecc.BN254.ScalarField())
	if err != nil {
		return out, err
	}
	proof, err := groth16.Prove(p.ccs, p.pk, full)
	if err != nil {
		return out, err
	}
	pub, err := full.Public()
	if err != nil {
		return out, err
	}
	if err := groth16.Verify(proof, p.vk, pub); err != nil {
		return out, fmt.Errorf("the proof does not verify: %w", err)
	}
	raw, err := proofenc.RawPlain(proof)
	if err != nil {
		return out, err
	}
	comp, err := proofenc.CompressPlain(proof)
	if err != nil {
		return out, err
	}
	out.Statement, out.Raw, out.Compressed = hex.EncodeToString(st.Encode()), hex.EncodeToString(raw), hex.EncodeToString(comp)
	for k, v := range pub.Vector().(fr.Vector) {
		out.Public[k] = hex32(v)
	}
	return out, nil
}

type fixture struct {
	name  string
	st    netting.Statement
	slots [netting.Slots]netting.WitnessSlot
}

// fixtureSet is the named set of nettings the program and gateway tests record. Every byte of a statement is bound
// by its proof, so the cases that depend on a record address move `expires` down from a far-future value, rebuilding
// the session field, root and content on each try, until the address has the wanted shape.
func fixtureSet(programs [][32]byte) ([]fixture, error) {
	const far, past = 4_000_000_000, 1_700_000_000
	grind := func(name string, n, seed int, start uint32, want func(netting.Statement) bool) (fixture, error) {
		for e := start; e > start-100_000; e-- {
			st, slots := netting.ExampleWith(n, seed, e)
			if want(st) {
				return fixture{name, st, slots}, nil
			}
		}
		return fixture{}, fmt.Errorf("%s: no expiry gives the wanted address", name)
	}
	off := func(st netting.Statement) bool {
		for _, id := range programs {
			if _, ok := netting.RecordAddress(id, st.Content()); !ok {
				return false
			}
		}
		return true
	}
	onCurve := func(which int) func(netting.Statement) bool {
		return func(st netting.Statement) bool {
			_, ok := netting.RecordAddress(programs[which], st.Content())
			return !ok
		}
	}
	var set []fixture
	add := func(f fixture, err error) error {
		if err != nil {
			return err
		}
		set = append(set, f)
		return nil
	}
	for _, n := range []int{2, 5, 8} {
		if err := add(grind(fmt.Sprintf("n%d", n), n, 0, far, off)); err != nil {
			return nil, err
		}
	}
	if err := add(grind("expired", 5, 0, past, off)); err != nil {
		return nil, err
	}
	if err := add(grind("on_curve", 5, 0, far, onCurve(0))); err != nil {
		return nil, err
	}
	second := 0
	if len(programs) > 1 {
		second = 1
	}
	if err := add(grind("on_curve_short", 5, 0, far, onCurve(second))); err != nil {
		return nil, err
	}
	for k := 0; k < 24; k++ {
		if err := add(grind(fmt.Sprintf("n5_%02d", k), 5, k+1, far, off)); err != nil {
			return nil, err
		}
	}
	return set, nil
}

type stringList []string

func (l *stringList) String() string     { return fmt.Sprint(*l) }
func (l *stringList) Set(s string) error { *l = append(*l, s); return nil }

const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

// base58Decode32 reads a 32-byte Solana address.
func base58Decode32(s string) (out [32]byte, err error) {
	n := new(big.Int)
	for _, c := range s {
		i := -1
		for k, a := range base58Alphabet {
			if a == c {
				i = k
			}
		}
		if i < 0 {
			return out, fmt.Errorf("%q is not base58", c)
		}
		n.Mul(n, big.NewInt(58)).Add(n, big.NewInt(int64(i)))
	}
	if n.BitLen() > 256 {
		return out, errors.New("longer than 32 bytes")
	}
	zeros := 0
	for zeros < len(s) && s[zeros] == '1' {
		zeros++
	}
	if len(n.Bytes())+zeros != 32 {
		return out, errors.New("not 32 bytes")
	}
	n.FillBytes(out[:])
	return out, nil
}
