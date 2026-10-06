#!/usr/bin/env bash
# Proves the notes the private settlement tests recorded and adds the proofs to the fixtures.
#
#   ZK_RECORD=DIR cargo test -p buckspay --features devnet --test zk_settle   (records, tests fail)
#   scripts/prove-zk-fixtures.sh DIR KEYS_CURRENT [KEYS_PREVIOUS]
#
# The keys are directories written by `buckspay-zk test-setup` or a ceremony; they must be the
# keys whose verifying keys the program was built with.
set -euo pipefail
cd "$(dirname "$0")/.."
dir="${1:?recorded notes}"
fixtures=programs/buckspay/tests/fixtures
prove() {
  [ -d "$dir/$1" ] || return 0
  (cd ../prover && go run ./cmd/buckspay-zk prove-batch --keys "$2" --in "$dir/$1" \
    --out "../anchor/$fixtures/zk_proofs_$3.json" 2>&1 | grep -v ' DBG ')
}
prove Current "${2:?current keys}" current
if [ -n "${3:-}" ]; then prove Previous "$3" previous; fi
