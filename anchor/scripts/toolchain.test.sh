#!/usr/bin/env bash
# Two cases: sourcing fixes a PATH whose first solana is another release (where the release is installed),
# and a machine without 4.3.0 is refused.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/older" "$work/home"
printf '#!/bin/sh\necho "solana-cli 3.1.10 (src:00000000; feat:0, client:Agave)"\n' > "$work/older/solana"
chmod +x "$work/older/solana"
release="$HOME/.local/share/solana/install/releases/4.3.0/solana-release/bin"

if [ -x "$release/solana" ]; then
  out="$(env -i HOME="$HOME" PATH="$work/older:/usr/bin:/bin" bash -c "source '$here/toolchain.sh' && solana --version && cargo build-sbf --version | head -1")" || fail "sourcing failed"
  echo "$out" | grep -q "^solana-cli 4.3.0 " || fail "solana is not 4.3.0: $out"
  echo "$out" | grep -q "^cargo-build-sbf 4.3.0" || fail "cargo build-sbf is not 4.3.0: $out"
fi

if env -i HOME="$work/home" PATH="$work/older:/usr/bin:/bin" bash -c "source '$here/toolchain.sh'" 2>/dev/null; then
  fail "a machine without 4.3.0 was accepted"
fi
echo "toolchain.test.sh: ok"
