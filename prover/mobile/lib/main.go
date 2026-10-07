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

//export BuckspayExpand
func BuckspayExpand(pkBin, pkDump *C.char) C.int {
	if pkBin == nil || pkDump == nil {
		return badArgsCode
	}
	return code(mobile.Expand(C.GoString(pkBin), C.GoString(pkDump)))
}

//export BuckspayRelease
func BuckspayRelease() { mobile.Release() }

func main() {}
