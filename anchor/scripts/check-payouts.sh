#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/toolchain.sh
cargo run --quiet --release --manifest-path tools/check-payouts/Cargo.toml -- programs/buckspay
