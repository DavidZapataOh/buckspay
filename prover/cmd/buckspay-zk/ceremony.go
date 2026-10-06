package main

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	mpcsetup "github.com/consensys/gnark/backend/groth16/bn254/mpcsetup"

	"github.com/DavidZapataOh/buckspay/prover/ceremony"
	"github.com/DavidZapataOh/buckspay/prover/keys"
)

func ceremonyCmd(args []string) error {
	if len(args) == 0 {
		return errors.New(usage)
	}
	cmd, args := args[0], args[1:]
	switch cmd {
	case "phase1-init":
		var log2 uint
		var out string
		if _, err := flags(cmd, args, func(fs *flag.FlagSet) {
			fs.UintVar(&log2, "log2", ceremony.Log2Domain, "log2 of the FFT domain")
			fs.StringVar(&out, "out", "", "output file")
		}); err != nil {
			return err
		}
		return writeFile(out, ceremony.Init1Size(uint8(log2)))
	case "phase1-contribute":
		var in, out string
		if _, err := flags(cmd, args, func(fs *flag.FlagSet) {
			fs.StringVar(&in, "in", "", "previous contribution")
			fs.StringVar(&out, "out", "", "output file")
		}); err != nil {
			return err
		}
		prev := new(mpcsetup.Phase1)
		if err := readFile(in, prev); err != nil {
			return err
		}
		next := ceremony.Contribute1(prev)
		fmt.Println("contribution", ceremony.ContributionHash(next))
		return writeFile(out, next)
	case "phase1-seal":
		return phase1Seal(args)
	case "phase2-init":
		var ccsPath, srsPath, out string
		if _, err := flags(cmd, args, func(fs *flag.FlagSet) {
			fs.StringVar(&ccsPath, "ccs", "ccs.bin", "constraint system")
			fs.StringVar(&srsPath, "srs", "", "sealed phase 1 parameters")
			fs.StringVar(&out, "out", "", "output file")
		}); err != nil {
			return err
		}
		ccs, err := loadCCS(ccsPath)
		if err != nil {
			return err
		}
		srs := new(mpcsetup.SrsCommons)
		if err := readFile(srsPath, srs); err != nil {
			return err
		}
		p, err := ceremony.Init2(ccs, srs)
		if err != nil {
			return err
		}
		return writeFile(out, p)
	case "phase2-contribute":
		var in, out string
		if _, err := flags(cmd, args, func(fs *flag.FlagSet) {
			fs.StringVar(&in, "in", "", "previous contribution")
			fs.StringVar(&out, "out", "", "output file")
		}); err != nil {
			return err
		}
		prev := new(mpcsetup.Phase2)
		if err := readFile(in, prev); err != nil {
			return err
		}
		next := ceremony.Contribute2(prev)
		fmt.Println("contribution", ceremony.ContributionHash(next))
		return writeFile(out, next)
	case "phase2-seal":
		return phase2Seal(args)
	case "local-test":
		return localTest(args)
	}
	return fmt.Errorf("unknown ceremony step %q", cmd)
}

func phase1Seal(args []string) error {
	var log2 uint
	var beacon, out string
	fs, err := flags("phase1-seal", args, func(fs *flag.FlagSet) {
		fs.UintVar(&log2, "log2", ceremony.Log2Domain, "log2 of the FFT domain")
		fs.StringVar(&beacon, "beacon", "", "beacon challenge, hex")
		fs.StringVar(&out, "out", "", "sealed parameters file")
	})
	if err != nil {
		return err
	}
	b, err := decodeHex(beacon)
	if err != nil {
		return err
	}
	var cs []*mpcsetup.Phase1
	var hashes []string
	for _, path := range fs.Args() {
		p := new(mpcsetup.Phase1)
		if err := readFile(path, p); err != nil {
			return err
		}
		hashes = append(hashes, ceremony.ContributionHash(p))
		cs = append(cs, p)
	}
	srs, err := ceremony.Seal1(uint8(log2), b, cs...)
	if err != nil {
		return err
	}
	if err := writeFile(out, &srs); err != nil {
		return err
	}
	return writeJSON(out+".json", sealed{Beacon: beacon, Log2: uint8(log2), Phase1: hashes})
}

func phase2Seal(args []string) error {
	var ccsPath, srsPath, beacon, out string
	fs, err := flags("phase2-seal", args, func(fs *flag.FlagSet) {
		fs.StringVar(&ccsPath, "ccs", "ccs.bin", "constraint system")
		fs.StringVar(&srsPath, "srs", "", "sealed phase 1 parameters")
		fs.StringVar(&beacon, "beacon", "", "beacon challenge, hex (the one phase 1 was sealed with)")
		fs.StringVar(&out, "out", "", "output directory")
	})
	if err != nil {
		return err
	}
	b, err := decodeHex(beacon)
	if err != nil {
		return err
	}
	var s sealed
	raw, err := os.ReadFile(srsPath + ".json")
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return err
	}
	if s.Beacon != beacon {
		return errors.New("the beacon differs from the one phase 1 was sealed with")
	}
	ccs, err := loadCCS(ccsPath)
	if err != nil {
		return err
	}
	srs := new(mpcsetup.SrsCommons)
	if err := readFile(srsPath, srs); err != nil {
		return err
	}
	var cs []*mpcsetup.Phase2
	var hashes []string
	for _, path := range fs.Args() {
		p := new(mpcsetup.Phase2)
		if err := readFile(path, p); err != nil {
			return err
		}
		hashes = append(hashes, ceremony.ContributionHash(p))
		cs = append(cs, p)
	}
	pk, vk, err := ceremony.Seal2(ccs, srs, b, cs...)
	if err != nil {
		return err
	}
	m, err := keys.Store(out, ccs, pk, vk, keys.Manifest{Beacon: beacon, Phase1: s.Phase1, Phase2: hashes})
	if err != nil {
		return err
	}
	fmt.Println("vk", m.VKSHA256)
	return nil
}

// localTest runs a whole ceremony on this machine with throwaway participants. Its keys are
// marked as test keys: whoever ran it can reconstruct the trapdoor, so they prove nothing about
// soundness and must never be pinned in a release build.
func localTest(args []string) error {
	var out string
	if _, err := flags("local-test", args, func(fs *flag.FlagSet) { fs.StringVar(&out, "out", "", "output directory") }); err != nil {
		return err
	}
	start := time.Now()
	step := func(what string) {
		fmt.Fprintf(os.Stderr, "%s: %s, peak RSS %d MB\n", what, time.Since(start).Round(time.Second), peakRSS())
	}
	ccs, err := compile()
	if err != nil {
		return err
	}
	step("compiled")
	sum := sha256.Sum256([]byte("zk-test-keys"))
	beacon := sum[:]
	p1 := []*mpcsetup.Phase1{ceremony.Contribute1(ceremony.Init1())}
	p1 = append(p1, ceremony.Contribute1(p1[0]))
	var h1 []string
	for _, p := range p1 {
		h1 = append(h1, ceremony.ContributionHash(p))
	}
	srs, err := ceremony.Seal1(ceremony.Log2Domain, beacon, p1...)
	if err != nil {
		return err
	}
	p1 = nil
	step("phase 1 sealed")
	q0, err := ceremony.Init2(ccs, &srs)
	if err != nil {
		return err
	}
	q := []*mpcsetup.Phase2{ceremony.Contribute2(q0)}
	q = append(q, ceremony.Contribute2(q[0]))
	var h2 []string
	for _, p := range q {
		h2 = append(h2, ceremony.ContributionHash(p))
	}
	step("phase 2 contributed")
	pk, vk, err := ceremony.Seal2(ccs, &srs, beacon, q...)
	if err != nil {
		return err
	}
	step("phase 2 sealed")
	m, err := keys.Store(filepath.Clean(out), ccs, pk, vk, keys.Manifest{Test: true, Beacon: fmt.Sprintf("%x", beacon), Phase1: h1, Phase2: h2})
	if err != nil {
		return err
	}
	fmt.Println("test keys written; vk", m.VKSHA256)
	return nil
}
