package main

import (
	"bytes"
	"os"
	"testing"
)

func TestClaimVectorsAreReproducible(t *testing.T) {
	want, err := claimVectorsJSON()
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile("../../testdata/claim-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("testdata/claim-vectors.json is stale: regenerate it with `buckspay-zk claim-vectors`")
	}
}
