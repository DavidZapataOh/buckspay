package main

import (
	"flag"
	"fmt"
	"path/filepath"

	"github.com/consensys/gnark/backend/groth16"

	"github.com/DavidZapataOh/buckspay/prover/keys"
)

// testSetup runs the single-party setup of gnark and stores the result as test keys. Whoever runs
// it holds the trapdoor, so the keys prove nothing about soundness. It exists for tests that need
// proofs under a fresh key without running a ceremony.
func testSetup(args []string) error {
	var out, name string
	if _, err := flags("test-setup", args, func(fs *flag.FlagSet) {
		fs.StringVar(&out, "out", "", "output directory")
		circuitFlag(fs, &name)
	}); err != nil {
		return err
	}
	if out == "" {
		return fmt.Errorf("usage: buckspay-zk test-setup [--circuit chain|claim] --out DIR")
	}
	ccs, err := compile(name)
	if err != nil {
		return err
	}
	pk, vk, err := groth16.Setup(ccs)
	if err != nil {
		return err
	}
	m, err := keys.Store(filepath.Clean(out), ccs, pk, vk, keys.Manifest{Test: true})
	if err != nil {
		return err
	}
	fmt.Println("test keys written; vk", m.VKSHA256)
	return nil
}
