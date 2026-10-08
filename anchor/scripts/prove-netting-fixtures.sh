#!/usr/bin/env bash
# Proves the example nettings under KEYS and writes the fixtures of the verifier crate and of the program tests.
#
#   scripts/prove-netting-fixtures.sh KEYS
#
# KEYS is a directory written by `buckspay-zk netting setup` or a ceremony: the keys whose verifying key the
# program is built with.
set -euo pipefail
cd "$(dirname "$0")/.."
anchor="$PWD"
keys="${1:?netting key directory}"
devnet=$(grep -m1 -A0 'declare_id!' programs/buckspay/src/lib.rs | sed -E 's/.*"(.*)".*/\1/')
short=$(grep 'declare_id!' programs/buckspay/src/lib.rs | sed -n 2p | sed -E 's/.*"(.*)".*/\1/')
(cd ../prover && go run ./cmd/buckspay-zk netting prove --keys "$keys" --fixtures "$anchor/crates/zk-verify/tests/fixtures/netting.json" \
  --program "$devnet" --program "$short")
jq '{vk_sha256, cases: [.cases[] | {name, statement, proof: .raw}]}' "$anchor/crates/zk-verify/tests/fixtures/netting.json" \
  > "$anchor/programs/buckspay/tests/fixtures/netting_proofs.json"
(cd .. && pnpm exec prettier --write --log-level warn anchor/crates/zk-verify/tests/fixtures/netting.json \
  anchor/programs/buckspay/tests/fixtures/netting_proofs.json)
