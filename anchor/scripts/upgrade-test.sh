#!/usr/bin/env bash
# Builds the program of a git ref (default: the commit before the lock instructions), then runs the
# test that upgrades a device it created to the current program.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/toolchain.sh
ref="${1:-d88d0b5}"
work="$(mktemp -d)"
trap 'git worktree remove --force "$work/previous" 2>/dev/null || true; rm -rf "$work"' EXIT
git worktree add --detach "$work/previous" "$ref" >/dev/null
(cd "$work/previous/anchor" && CARGO_TARGET_DIR="$work/target" cargo build-sbf --features devnet)
cargo build-sbf --features devnet
PREVIOUS_PROGRAM="$work/target/deploy/buckspay.so" cargo test -p buckspay --features devnet --test upgrade -- --include-ignored
