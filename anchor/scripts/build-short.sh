#!/usr/bin/env bash
# Builds the short-windows program into target/deploy-short, where the gateway's tests look for it,
# without disturbing the production build in target/deploy.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/toolchain.sh
cargo build-sbf --features devnet,short-windows --sbf-out-dir target/deploy-short
