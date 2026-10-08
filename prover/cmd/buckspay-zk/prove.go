package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/frontend"

	"github.com/DavidZapataOh/buckspay/prover/keys"
	"github.com/DavidZapataOh/buckspay/prover/witness"
)

func loadVectors(path string) (*witness.Vectors, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var v witness.Vectors
	return &v, json.Unmarshal(raw, &v)
}

// peakRSS is the high-water mark of the resident set in MB, from /proc.
func peakRSS() int {
	raw, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if rest, ok := strings.CutPrefix(line, "VmHWM:"); ok {
			var kb int
			fmt.Sscanf(strings.TrimSpace(rest), "%d", &kb)
			return kb / 1024
		}
	}
	return 0
}

func vectorsCheck(args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: buckspay-zk vectors-check vectors.json")
	}
	v, err := loadVectors(args[0])
	if err != nil {
		return err
	}
	ccs, err := compile("chain")
	if err != nil {
		return err
	}
	solves := func(c *witness.Chain, i int) (bool, error) {
		a, err := witness.Assign(c, i)
		if err != nil {
			return false, err
		}
		w, err := frontend.NewWitness(a, ecc.BN254.ScalarField())
		if err != nil {
			return false, err
		}
		return ccs.IsSolved(w) == nil, nil
	}
	valid, invalid := 0, 0
	for _, c := range v.Valid {
		for i := range c.Messages {
			ok, err := solves(c.Chain(), i)
			if err != nil || !ok {
				return fmt.Errorf("valid %s/%d does not solve (%v)", c.Name, i, err)
			}
			valid++
		}
	}
	for _, c := range v.Invalid {
		ok, err := solves(c.Chain(), c.Bad)
		if err != nil || ok {
			return fmt.Errorf("invalid %s was accepted or not built (%v)", c.Name, err)
		}
		invalid++
	}
	fmt.Printf("%d valid messages solve, %d invalid messages are refused\n", valid, invalid)
	return nil
}

func proveCmd(args []string) error {
	var dir, vectors, name string
	var msg int
	if _, err := flags("prove", args, func(fs *flag.FlagSet) {
		fs.StringVar(&dir, "keys", "", "directory written by a ceremony")
		fs.StringVar(&vectors, "vectors", "", "vectors.json")
		fs.StringVar(&name, "chain", "", "valid chain name")
		fs.IntVar(&msg, "message", 0, "message index")
	}); err != nil {
		return err
	}
	v, err := loadVectors(vectors)
	if err != nil {
		return err
	}
	c := v.ByName(name)
	if c == nil {
		return fmt.Errorf("no valid chain %q", name)
	}
	ccs, err := loadCCS(filepath.Join(dir, "ccs.bin"))
	if err != nil {
		return err
	}
	pk := groth16.NewProvingKey(ecc.BN254)
	f, err := os.Open(filepath.Join(dir, "pk.dump"))
	if err != nil {
		return err
	}
	if err := pk.ReadDump(bufio.NewReaderSize(f, 1<<20)); err != nil {
		return err
	}
	f.Close()
	vk := groth16.NewVerifyingKey(ecc.BN254)
	if err := readFile(filepath.Join(dir, "vk.bin"), vk); err != nil {
		return err
	}
	a, err := witness.Assign(c.Chain(), msg)
	if err != nil {
		return err
	}
	full, err := frontend.NewWitness(a, ecc.BN254.ScalarField())
	if err != nil {
		return err
	}
	start := time.Now()
	proof, err := groth16.Prove(ccs, pk, full, backend.WithProverHashToFieldFunction(sha256.New()))
	if err != nil {
		return err
	}
	took := time.Since(start)
	pub, err := full.Public()
	if err != nil {
		return err
	}
	if err := groth16.Verify(proof, vk, pub, backend.WithVerifierHashToFieldFunction(sha256.New())); err != nil {
		return fmt.Errorf("the proof does not verify: %w", err)
	}
	fmt.Printf("proved and verified %s/%d in %s, peak RSS %d MB\n", name, msg, took.Round(time.Millisecond), peakRSS())
	return nil
}

func exportVK(args []string) error {
	var rust, test bool
	var name string
	fs, err := flags("export-vk", args, func(fs *flag.FlagSet) {
		circuitFlag(fs, &name)
		fs.BoolVar(&rust, "rust", false, "write a Rust source file")
		fs.BoolVar(&test, "test-keys", false, "mark the key as a test key whose trapdoor is known")
	})
	if err != nil {
		return err
	}
	if !rust || fs.NArg() != 1 {
		return fmt.Errorf("usage: buckspay-zk export-vk --rust [--circuit chain|claim|netting] [--test-keys] vk.bin")
	}
	vk := groth16.NewVerifyingKey(ecc.BN254)
	if err := readFile(fs.Arg(0), vk); err != nil {
		return err
	}
	var opts []keys.ExportOption
	switch name {
	case "claim":
		opts = append(opts, keys.Claim())
	case "netting":
		opts = append(opts, keys.Netting())
	}
	if raw, err := os.ReadFile(filepath.Join(filepath.Dir(fs.Arg(0)), "manifest.json")); err == nil {
		var m keys.Manifest
		if err := json.Unmarshal(raw, &m); err != nil {
			return err
		}
		test = test || m.Test
	}
	if test {
		opts = append(opts, keys.TestKeys())
	}
	return keys.ExportRust(vk, os.Stdout, opts...)
}
