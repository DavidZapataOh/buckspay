// Package keys stores, hashes and exports the artifacts of a trusted setup.
package keys

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/consensys/gnark/backend/groth16"
	groth16bn254 "github.com/consensys/gnark/backend/groth16/bn254"
	"github.com/consensys/gnark/constraint"

	"github.com/DavidZapataOh/buckspay/prover/circuit"
	"github.com/DavidZapataOh/buckspay/prover/claim"
)

// Manifest lists the artifacts of one setup and how they were made. Hashes are SHA-256 in hex.
type Manifest struct {
	VKSHA256     string
	PKBinSHA256  string
	PKDumpSHA256 string
	CCSSHA256    string
	Beacon       string
	Phase1       []string // contribution hashes, in order
	Phase2       []string
	Constraints  int
	// Test marks keys made by a throwaway local ceremony: their trapdoor is known.
	Test bool
}

// Store writes ccs.bin, pk.bin (compressed), pk.dump (raw), vk.bin and manifest.json into dir and
// returns the manifest with the hashes of what it wrote. m carries the beacon and the contribution
// hashes; its hashes and constraint count are filled in here.
func Store(dir string, ccs constraint.ConstraintSystem, pk groth16.ProvingKey, vk groth16.VerifyingKey, m Manifest) (Manifest, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return m, err
	}
	write := func(name string, w func(io.Writer) error) (string, error) {
		f, err := os.Create(filepath.Join(dir, name))
		if err != nil {
			return "", err
		}
		defer f.Close()
		h := sha256.New()
		if err := w(io.MultiWriter(f, h)); err != nil {
			return "", err
		}
		return hex.EncodeToString(h.Sum(nil)), f.Close()
	}
	var err error
	if m.CCSSHA256, err = write("ccs.bin", func(w io.Writer) error { _, err := ccs.WriteTo(w); return err }); err != nil {
		return m, err
	}
	if m.PKBinSHA256, err = write("pk.bin", func(w io.Writer) error { _, err := pk.WriteTo(w); return err }); err != nil {
		return m, err
	}
	if m.PKDumpSHA256, err = write("pk.dump", pk.WriteDump); err != nil {
		return m, err
	}
	if m.VKSHA256, err = write("vk.bin", func(w io.Writer) error { _, err := vk.WriteTo(w); return err }); err != nil {
		return m, err
	}
	m.Constraints = ccs.GetNbConstraints()
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return m, err
	}
	return m, os.WriteFile(filepath.Join(dir, "manifest.json"), append(raw, '\n'), 0o644)
}

// ExportOption changes what ExportRust writes.
type ExportOption func(*exportOptions)

type exportOptions struct {
	test        bool
	name        string
	numPublic   int
	commitments int
}

func defaultExport() exportOptions {
	return exportOptions{name: "per-message", numPublic: circuit.NumPublic, commitments: 1}
}

// Claim exports the key of the claim circuit, which has no BSB22 commitment: IC holds the constant
// one and the public inputs, and the commitment constants are not written.
func Claim() ExportOption {
	return func(o *exportOptions) { o.name, o.numPublic, o.commitments = "claim", claim.NumPublic, 0 }
}

// TestKeys marks the exported key as a test key: TEST_KEYS is true in the generated file, so that
// a verifier can refuse it on a production cluster.
func TestKeys() ExportOption { return func(o *exportOptions) { o.test = true } }

// ExportRust writes the verifying key as the constants of a Rust source file, with the points in
// the big-endian layout of the alt_bn128 syscalls (G2 as x.c1, x.c0, y.c1, y.c0). It refuses a
// key that does not have the shape of the circuit.
func ExportRust(vk groth16.VerifyingKey, w io.Writer, opts ...ExportOption) error {
	o := defaultExport()
	for _, opt := range opts {
		opt(&o)
	}
	key, ok := vk.(*groth16bn254.VerifyingKey)
	if !ok {
		return errors.New("not a BN254 Groth16 verifying key")
	}
	icLen := o.numPublic + 1 + o.commitments
	if len(key.G1.K) != icLen {
		return fmt.Errorf("IC has %d points, the circuit has %d", len(key.G1.K), icLen)
	}
	if len(key.CommitmentKeys) != o.commitments {
		return fmt.Errorf("%d commitment keys, the circuit has %d", len(key.CommitmentKeys), o.commitments)
	}
	var raw bytes.Buffer
	if _, err := key.WriteTo(&raw); err != nil {
		return err
	}
	sum := sha256.Sum256(raw.Bytes())

	var out strings.Builder
	fmt.Fprintf(&out, "// Generated from the verifying key of the %s circuit. Do not edit.\n\n", o.name)
	if o.test {
		out.WriteString("// Made by a throwaway local ceremony: its trapdoor is known. Never pin it in a release build.\n")
	}
	fmt.Fprintf(&out, "pub const TEST_KEYS: bool = %t;\n", o.test)
	fmt.Fprintf(&out, "pub const NUM_PUBLIC: usize = %d;\n", o.numPublic)
	fmt.Fprintf(&out, "const _: () = assert!(IC.len() == NUM_PUBLIC + %d);\n\n", 1+o.commitments)
	constant := func(name string, size int, b []byte) {
		fmt.Fprintf(&out, "#[rustfmt::skip]\npub const %s: [u8; %d] = [%s];\n", name, size, hexList(b))
	}
	constant("VK_SHA256", 32, sum[:])
	constant("ALPHA_G1", 64, g1(&key.G1.Alpha))
	constant("BETA_G2", 128, g2(&key.G2.Beta))
	constant("GAMMA_G2", 128, g2(&key.G2.Gamma))
	constant("DELTA_G2", 128, g2(&key.G2.Delta))
	fmt.Fprintf(&out, "#[rustfmt::skip]\npub const IC: [[u8; 64]; %d] = [\n", icLen)
	for i := range key.G1.K {
		fmt.Fprintf(&out, "    [%s],\n", hexList(g1(&key.G1.K[i])))
	}
	out.WriteString("];\n")
	if o.commitments == 1 {
		constant("COMMITMENT_KEY_G", 128, g2(&key.CommitmentKeys[0].G))
		constant("COMMITMENT_KEY_G_SIGMA_NEG", 128, g2(&key.CommitmentKeys[0].GSigmaNeg))
	}
	_, err := io.WriteString(w, out.String())
	return err
}

func hexList(b []byte) string {
	parts := make([]string, len(b))
	for i, v := range b {
		parts[i] = fmt.Sprintf("0x%02x", v)
	}
	return strings.Join(parts, ", ")
}

func g1(p *bn254.G1Affine) []byte {
	x, y := p.X.Bytes(), p.Y.Bytes()
	return append(x[:], y[:]...)
}

func g2(p *bn254.G2Affine) []byte {
	var out []byte
	for _, c := range []interface{ Bytes() [32]byte }{&p.X.A1, &p.X.A0, &p.Y.A1, &p.Y.A0} {
		b := c.Bytes()
		out = append(out, b[:]...)
	}
	return out
}
