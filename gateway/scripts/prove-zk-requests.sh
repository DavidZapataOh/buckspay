#!/usr/bin/env bash
# Proves the notes the private settlement tests recorded and writes their requests.
#
#   ZK_RECORD=DIR cargo test --test zk   (records, tests fail)
#   scripts/prove-zk-requests.sh DIR KEYS
#
# KEYS is the directory written by `buckspay-zk test-setup` whose verifying key the program is
# built with. The note `n3` is proved twice, as `n3b`, to have two proofs of the same chain.
set -euo pipefail
cd "$(dirname "$0")/.."
dir="${1:?recorded notes}"
keys="$(realpath "${2:?keys}")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
prove() {
  (cd ../prover && go run ./cmd/buckspay-zk prove-batch --keys "$keys" --in "$1" --out "$2" 2>&1 | grep -v ' DBG ')
}
prove "$dir/main" "$work/proofs.json"
mkdir "$work/again"
cp "$dir/main/n3.json" "$work/again/"
prove "$work/again" "$work/again.json"
python3 - "$dir" "$work" <<'PY'
import base64, glob, json, os, sys

dir, work = sys.argv[1:]
b64 = lambda hexed: base64.b64encode(bytes.fromhex(hexed)).decode()
proved = {}
for name in ("proofs.json", "again.json"):
    file = json.load(open(os.path.join(work, name)))
    for case in file["cases"]:
        proved[(name, case["name"])] = case["proofs"]
requests = {}
for path in sorted(glob.glob(os.path.join(dir, "*.request.json"))):
    request = json.load(open(path))
    name = request.pop("name")
    for out, source in ((name, "proofs.json"), ("n3b" if name == "n3" else None, "again.json")):
        if out is None:
            continue
        copy = json.loads(json.dumps(request))
        proofs = proved[(source, "gateway-note-" + name)]
        last = len(copy["messages"]) - 1
        for i, message in enumerate(copy["messages"]):
            message["proof"] = b64(proofs[i]["compressed"])
            message["sOut"] = b64("00" * 32 if i == last else proofs[i]["public"][4])
        requests[out] = copy
out = os.path.join("tests", "fixtures", "zk_requests.json")
vk = json.load(open(os.path.join(work, "proofs.json")))["vk_sha256"]
json.dump({"vkSha256": vk, "requests": requests}, open(out, "w"), indent=1, sort_keys=True)
open(out, "a").write("\n")
PY
