package main

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/consensys/gnark-crypto/ecc"
	cs_bn254 "github.com/consensys/gnark/constraint/bn254"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"

	"github.com/DavidZapataOh/buckspay/prover/circuit"
	"github.com/DavidZapataOh/buckspay/prover/claim"
)

func flags(name string, args []string, define func(*flag.FlagSet)) (*flag.FlagSet, error) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	define(fs)
	return fs, fs.Parse(args)
}

func writeFile(path string, w io.WriterTo) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	b := bufio.NewWriterSize(f, 1<<20)
	if _, err := w.WriteTo(b); err != nil {
		return err
	}
	if err := b.Flush(); err != nil {
		return err
	}
	return f.Close()
}

func readFile(path string, r io.ReaderFrom) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = r.ReadFrom(bufio.NewReaderSize(f, 1<<20))
	return err
}

// circuitFlag registers --circuit, which selects the circuit a command works on.
func circuitFlag(fs *flag.FlagSet, name *string) {
	fs.StringVar(name, "circuit", "chain", "circuit: chain or claim")
}

func compile(name string) (*cs_bn254.R1CS, error) {
	var c frontend.Circuit
	switch name {
	case "chain":
		c = &circuit.Message{}
	case "claim":
		c = &claim.Claim{}
	default:
		return nil, fmt.Errorf("unknown circuit %q", name)
	}
	ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, c)
	if err != nil {
		return nil, err
	}
	return ccs.(*cs_bn254.R1CS), nil
}

func loadCCS(path string) (*cs_bn254.R1CS, error) {
	ccs := new(cs_bn254.R1CS)
	if err := readFile(path, ccs); err != nil {
		return nil, err
	}
	return ccs, nil
}

func compileCmd(args []string) error {
	var out, name string
	if _, err := flags("compile", args, func(fs *flag.FlagSet) {
		fs.StringVar(&out, "out", "ccs.bin", "constraint system file")
		circuitFlag(fs, &name)
	}); err != nil {
		return err
	}
	ccs, err := compile(name)
	if err != nil {
		return err
	}
	return writeFile(out, ccs)
}

func decodeHex(s string) ([]byte, error) {
	b, err := hex.DecodeString(strings.TrimSpace(s))
	if err != nil || len(b) == 0 {
		return nil, fmt.Errorf("--beacon must be non-empty hex: %v", err)
	}
	return b, nil
}

type sealed struct {
	Beacon string   `json:"beacon"`
	Log2   uint8    `json:"log2"`
	Phase1 []string `json:"phase1"`
}

func writeJSON(path string, v any) error {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(raw, '\n'), 0o644)
}
