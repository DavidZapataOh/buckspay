// Command lib is the shared library the app loads in its prover process: cgo exports over package mobile.
package main

/*
#include <stddef.h>
#include <stdint.h>
*/
import "C"

import (
	"errors"
	"unsafe"

	"github.com/DavidZapataOh/buckspay/prover/mobile"
)

const (
	okCode      = 0
	noKeyCode   = -1
	badArgsCode = -2
	failCode    = -3
)

func code(err error) C.int {
	switch {
	case err == nil:
		return okCode
	case errors.Is(err, mobile.ErrNoKey):
		return noKeyCode
	default:
		return failCode
	}
}

//export BuckspayLoad
func BuckspayLoad(dir *C.char) C.int {
	if dir == nil {
		return badArgsCode
	}
	return code(mobile.Load(C.GoString(dir)))
}

//export BuckspayProve
func BuckspayProve(chain *C.uint8_t, n C.size_t, index C.int, out *C.uint8_t) C.int {
	if chain == nil || out == nil || n == 0 {
		return badArgsCode
	}
	res, err := mobile.Prove(C.GoBytes(unsafe.Pointer(chain), C.int(n)), int(index))
	if err != nil {
		return code(err)
	}
	copy(unsafe.Slice((*byte)(unsafe.Pointer(out)), len(res)), res)
	return okCode
}

//export BuckspayLoadClaim
func BuckspayLoadClaim(dir *C.char) C.int {
	if dir == nil {
		return badArgsCode
	}
	return code(mobile.LoadClaim(C.GoString(dir)))
}

//export BuckspayProveClaim
func BuckspayProveClaim(req *C.uint8_t, n C.size_t, out *C.uint8_t) C.int {
	if req == nil || out == nil || n == 0 {
		return badArgsCode
	}
	res, err := mobile.ProveClaim(C.GoBytes(unsafe.Pointer(req), C.int(n)))
	if err != nil {
		return code(err)
	}
	copy(unsafe.Slice((*byte)(unsafe.Pointer(out)), len(res)), res)
	return okCode
}

//export BuckspayProveNetting
func BuckspayProveNetting(witness *C.uint8_t, n C.size_t, keyDir *C.char, out *C.uint8_t) C.int {
	if witness == nil || keyDir == nil || out == nil || n == 0 {
		return badArgsCode
	}
	res, err := mobile.ProveNetting(C.GoBytes(unsafe.Pointer(witness), C.int(n)), C.GoString(keyDir))
	if err != nil {
		return code(err)
	}
	copy(unsafe.Slice((*byte)(unsafe.Pointer(out)), len(res)), res)
	return okCode
}

// BuckspayVerifyNetting returns 1 when the proof verifies, 0 when a well-formed proof does not, and a negative
// code otherwise.
//
//export BuckspayVerifyNetting
func BuckspayVerifyNetting(proof, public *C.uint8_t, vkPath *C.char) C.int {
	if proof == nil || public == nil || vkPath == nil {
		return badArgsCode
	}
	ok, err := mobile.VerifyNetting(C.GoBytes(unsafe.Pointer(proof), C.int(mobile.NettingProofLen)),
		C.GoBytes(unsafe.Pointer(public), C.int(4*32)), C.GoString(vkPath))
	switch {
	case err != nil:
		return failCode
	case ok:
		return 1
	}
	return 0
}

//export BuckspayExpand
func BuckspayExpand(pkBin, pkDump *C.char) C.int {
	if pkBin == nil || pkDump == nil {
		return badArgsCode
	}
	return code(mobile.Expand(C.GoString(pkBin), C.GoString(pkDump)))
}

//export BuckspayRelease
func BuckspayRelease() {
	mobile.Release()
	mobile.ReleaseClaim()
	mobile.ReleaseNetting()
}

func main() {}
