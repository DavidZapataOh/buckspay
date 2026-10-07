// Command buckspay-zk is the tooling around the per-message validity circuit: constraint counts,
// the trusted setup ceremony, key export and a server-side prover.
package main

import (
	"fmt"
	"os"

	"github.com/DavidZapataOh/buckspay/prover/circuit"
)

const usage = `usage:
  buckspay-zk count
  buckspay-zk compile [--circuit chain|claim] --out ccs.bin
  buckspay-zk vectors-check vectors.json
  buckspay-zk ceremony phase1-init --log2 N --out FILE
  buckspay-zk ceremony phase1-contribute --in FILE --out FILE
  buckspay-zk ceremony phase1-seal --log2 N --beacon HEX --out SRS FILE...
  buckspay-zk ceremony phase2-init --ccs ccs.bin --srs SRS --out FILE
  buckspay-zk ceremony phase2-contribute --in FILE --out FILE
  buckspay-zk ceremony phase2-seal --ccs ccs.bin --srs SRS --beacon HEX --out DIR FILE...
  buckspay-zk ceremony local-test [--circuit chain|claim] [--log2 N] --out DIR
  buckspay-zk test-setup [--circuit chain|claim] --out DIR
  buckspay-zk prove-batch --keys DIR --in chains.json --out proofs.json
  buckspay-zk fixtures --keys DIR --vectors vectors.json --out DIR
  buckspay-zk export-vk --rust [--circuit chain|claim] [--test-keys] vk.bin
  buckspay-zk claim-vectors
  buckspay-zk claim-fixtures --keys DIR --out FILE
  buckspay-zk prove --keys DIR --vectors vectors.json --chain NAME --message I`

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "buckspay-zk:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf(usage)
	}
	switch args[0] {
	case "count":
		c, err := circuit.Count()
		if err != nil {
			return err
		}
		fmt.Printf("constraints=%d p256=%d sha256=%d rules=%d public=%d\n", c.Total, c.P256, c.SHA256, c.Rules, circuit.NumPublic)
		return nil
	case "compile":
		return compileCmd(args[1:])
	case "vectors-check":
		return vectorsCheck(args[1:])
	case "ceremony":
		return ceremonyCmd(args[1:])
	case "test-setup":
		return testSetup(args[1:])
	case "prove-batch":
		return proveBatch(args[1:])
	case "fixtures":
		return fixtures(args[1:])
	case "export-vk":
		return exportVK(args[1:])
	case "claim-vectors":
		return claimVectors(args[1:])
	case "claim-fixtures":
		return claimFixtures(args[1:])
	case "prove":
		return proveCmd(args[1:])
	}
	return fmt.Errorf("unknown command %q\n%s", args[0], usage)
}
