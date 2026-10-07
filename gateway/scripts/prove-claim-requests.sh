#!/usr/bin/env bash
# Proves the claims the reward tests recorded and adds the proofs to the fixtures.
#
#   CLAIM_RECORD=DIR cargo test --test rewards_claims   (records, tests fail)
#   scripts/prove-claim-requests.sh DIR KEYS
#
# KEYS is the directory written by `buckspay-zk test-setup --circuit claim` whose verifying key the
# program is built with. Proofs already in the fixtures are kept, and a proof is looked up by its
# public inputs.
set -euo pipefail
cd "$(dirname "$0")/.."
dir="${1:?recorded requests}"
keys="$(realpath "${2:?keys}")"
fixture="$PWD/tests/fixtures/claim_proofs.json"
out="$(mktemp)"
trap 'rm -f "$out"' EXIT
(cd ../prover && go run ./cmd/buckspay-zk claim-prove-batch --keys "$keys" --in "$dir/requests.json" --out "$out" \
  2>&1 | { grep -v ' DBG ' || true; })
python3 - "$fixture" "$out" <<'PY'
import json, sys
path, new = sys.argv[1:]
old, new = json.load(open(path)), json.load(open(new))
claims = {c["key"]: c for c in old["claims"]}
claims.update({c["key"]: c for c in new["claims"]})
json.dump({"vk_sha256": new["vk_sha256"], "claims": list(claims.values())}, open(path, "w"), indent=1)
open(path, "a").write("\n")
PY
(cd .. && pnpm exec prettier --write --log-level warn gateway/tests/fixtures/claim_proofs.json)
