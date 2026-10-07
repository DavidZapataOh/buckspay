#!/usr/bin/env bash
# Proves the claims the reward tests recorded and adds the proofs to the fixtures.
#
#   CLAIM_RECORD=DIR cargo test -p buckspay --features devnet --test reward_claims   (records, tests fail)
#   scripts/prove-claim-fixtures.sh DIR KEYS_CURRENT [KEYS_PREVIOUS]
#
# The keys are directories written by `buckspay-zk test-setup --circuit claim` or a ceremony; they
# must be the keys whose verifying keys the program was built with. Proofs already in the fixtures
# are kept, and a proof is looked up by its public inputs.
set -euo pipefail
cd "$(dirname "$0")/.."
dir="${1:?recorded requests}"
fixtures="$PWD/programs/buckspay/tests/fixtures"
prove() {
  [ -f "$dir/requests_$1.json" ] || return 0
  local out
  out="$(mktemp)"
  (cd ../prover && go run ./cmd/buckspay-zk claim-prove-batch --keys "$2" --in "$dir/requests_$1.json" --out "$out" \
    2>&1 | { grep -v ' DBG ' || true; })
  python3 - "$fixtures/claim_proofs_$1.json" "$out" <<'PY'
import json, sys
path, new = sys.argv[1:]
old, new = json.load(open(path)), json.load(open(new))
claims = {c["key"]: c for c in old["claims"]}
claims.update({c["key"]: c for c in new["claims"]})
json.dump({"vk_sha256": new["vk_sha256"], "claims": list(claims.values())}, open(path, "w"), indent=1)
open(path, "a").write("\n")
PY
  rm -f "$out"
  (cd .. && pnpm exec prettier --write --log-level warn "anchor/programs/buckspay/tests/fixtures/claim_proofs_$1.json")
}
prove current "${2:?current keys}"
if [ -n "${3:-}" ]; then prove previous "$3"; fi
