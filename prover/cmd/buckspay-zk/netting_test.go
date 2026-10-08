package main

import (
	"bytes"
	"os"
	"testing"

	"github.com/DavidZapataOh/buckspay/prover/netting"
)

func TestNettingVectorsCommandWritesTheTestdata(t *testing.T) {
	want, err := os.ReadFile("../../netting/testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	got, err := netting.VectorsJSON()
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("vectors differ: %v", err)
	}
}

func TestCircuitFlagAcceptsNetting(t *testing.T) {
	ccs, err := compile("netting")
	if err != nil {
		t.Fatal(err)
	}
	if got := ccs.GetNbPublicVariables(); got != netting.NumPublic+1 {
		t.Fatalf("%d public variables, want %d (one is the constant)", got, netting.NumPublic+1)
	}
}
