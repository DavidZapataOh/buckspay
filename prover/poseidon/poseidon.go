// Copyright 2021-2026 Light Protocol Labs. Licensed under the Apache License, Version 2.0.
// Modified: the Lean extraction layer is removed, only width 3 is kept and a native hash is added.

// Package poseidon is the Poseidon hash of two BN254 field elements, in the circom-compatible
// parameters (x^5, 8 full and 57 partial rounds, width 3) that the sol_poseidon syscall computes,
// both as a gnark gadget and natively.
//
// The gadget follows github.com/Lightprotocol/light-protocol at commit
// a67a427e6c58a38dd2e6a16a4042ca91d7cf4571 (prover/server/prover/poseidon), Apache-2.0, without its
// Lean extraction layer.
//
// The gadget reduces a witness modulo r, so a value of r or more is hashed as its residue, while
// the syscall refuses it. Every value that reaches Hash must already be canonical (below r); see
// the claim package, which builds its witnesses only from canonical values.
package poseidon

import (
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark/frontend"
)

const (
	width         = 3
	fullRounds    = 8
	partialRounds = 57
)

var (
	nativeMDS    [width][width]fr.Element
	nativeRounds [fullRounds + partialRounds][width]fr.Element
)

func init() {
	for i := range nativeMDS {
		for j := range nativeMDS[i] {
			nativeMDS[i][j].SetBigInt(&mds3[i][j])
		}
	}
	for i := range nativeRounds {
		for j := range nativeRounds[i] {
			nativeRounds[i][j].SetBigInt(&constants3[i][j])
		}
	}
}

func isFull(round int) bool {
	return round < fullRounds/2 || round >= fullRounds/2+partialRounds
}

// Hash returns Poseidon(a, b) as a circuit variable.
func Hash(api frontend.API, a, b frontend.Variable) frontend.Variable {
	state := [width]frontend.Variable{0, a, b}
	for r := range nativeRounds {
		for i := range state {
			state[i] = api.Add(state[i], &constants3[r][i])
		}
		for i := range state {
			if i == 0 || isFull(r) {
				state[i] = sbox(api, state[i])
			}
		}
		var next [width]frontend.Variable
		for i := range next {
			sum := frontend.Variable(0)
			for j := range state {
				sum = api.Add(sum, api.Mul(state[j], &mds3[i][j]))
			}
			next[i] = sum
		}
		state = next
	}
	return state[0]
}

func sbox(api frontend.API, x frontend.Variable) frontend.Variable {
	x2 := api.Mul(x, x)
	x4 := api.Mul(x2, x2)
	return api.Mul(x, x4)
}

// Native returns Poseidon(a, b) outside a circuit.
func Native(a, b fr.Element) fr.Element {
	state := [width]fr.Element{{}, a, b}
	for r := range nativeRounds {
		for i := range state {
			state[i].Add(&state[i], &nativeRounds[r][i])
		}
		for i := range state {
			if i == 0 || isFull(r) {
				var x2, x4 fr.Element
				x2.Square(&state[i])
				x4.Square(&x2)
				state[i].Mul(&state[i], &x4)
			}
		}
		var next [width]fr.Element
		for i := range next {
			for j := range state {
				var t fr.Element
				t.Mul(&state[j], &nativeMDS[i][j])
				next[i].Add(&next[i], &t)
			}
		}
		state = next
	}
	return state[0]
}
