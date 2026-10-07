#!/usr/bin/env bash
# Builds libbuckspay_prover.so into the prover module's jniLibs: arm64-v8a by default, or the ABIs
# named as arguments (x86_64 is for emulators). NDK is the NDK directory (default: the newest under
# $ANDROID_HOME/ndk).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
ndk="${NDK:-$(ls -d "${ANDROID_HOME:?ANDROID_HOME is not set}"/ndk/* | sort -V | tail -1)}"
bin="$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin"
abis=("${@:-arm64-v8a}")

cd "$root/prover"
for abi in "${abis[@]}"; do
  case "$abi" in
    arm64-v8a) goarch=arm64 triple=aarch64-linux-android24 ;;
    x86_64) goarch=amd64 triple=x86_64-linux-android24 ;;
    *) echo "unsupported ABI $abi" >&2; exit 1 ;;
  esac
  out="$root/modules/prover/android/src/main/jniLibs/$abi"
  mkdir -p "$out"
  CGO_ENABLED=1 GOOS=android GOARCH="$goarch" CC="$bin/$triple-clang" \
    go build -buildmode=c-shared -trimpath \
    -ldflags="-s -w -extldflags=-Wl,-z,max-page-size=16384" \
    -o "$out/libbuckspay_prover.so" ./mobile/lib
  rm -f "$out/libbuckspay_prover.h"
  if "$bin/llvm-readelf" -lW "$out/libbuckspay_prover.so" | awk '/LOAD/ {print $NF}' | grep -qv 0x4000; then
    echo "a LOAD segment of the $abi library is not aligned to 16 KB" >&2
    exit 1
  fi
done
