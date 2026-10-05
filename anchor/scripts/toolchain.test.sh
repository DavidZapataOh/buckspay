#!/usr/bin/env bash
# Two cases: sourcing fixes a PATH whose first solana is another release, and a machine without 4.3.0 is refused.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }
older="$HOME/.local/share/solana/install/active_release/bin"

out="$(env -i HOME="$HOME" PATH="$older:/usr/bin:/bin" bash -c "source '$here/toolchain.sh' && solana --version && cargo build-sbf --version | head -1")" || fail "sourcing failed"
echo "$out" | grep -q "^solana-cli 4.3.0 " || fail "solana is not 4.3.0: $out"
echo "$out" | grep -q "^cargo-build-sbf 4.3.0" || fail "cargo build-sbf is not 4.3.0: $out"

fakehome="$(mktemp -d)"
if env -i HOME="$fakehome" PATH="$older:/usr/bin:/bin" bash -c "source '$here/toolchain.sh'" 2>/dev/null; then
  fail "a machine without 4.3.0 was accepted"
fi
rm -rf "$fakehome"
echo "toolchain.test.sh: ok"
