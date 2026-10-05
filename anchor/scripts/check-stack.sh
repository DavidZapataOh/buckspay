#!/usr/bin/env bash
# cargo build-sbf reports stack overflows as "Error:" lines and still exits 0, so scan its output.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/toolchain.sh
log="$(mktemp)"
cargo build-sbf --features "${1:-devnet}" 2>&1 | tee "$log"
if grep -E "Stack offset|exceeded max offset|overwrites values in the frame" "$log"; then
  echo "stack check failed: box the accounts of the context named above" >&2
  exit 1
fi
