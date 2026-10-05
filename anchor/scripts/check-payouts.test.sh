#!/usr/bin/env bash
# Plants each way of moving tokens or invoking a program that the payout lint exists to catch in
# register_device.rs of a scratch copy of the program: the lint must exit 1 for each, and 0 for the
# program as it is.
set -u
cd "$(dirname "$0")/.."
source scripts/toolchain.sh
fail() { echo "FAIL: $*" >&2; exit 1; }
lint() { cargo run --quiet --release --manifest-path tools/check-payouts/Cargo.toml -- "$1" >/dev/null 2>&1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -r programs/buckspay "$work/program"
rm -rf "$work/program/tests"

lint "$work/program" || fail "the program is not clean"

target="$work/program/src/instructions/register_device.rs"
cp "$target" "$work/original.rs"
plants=(
  'use anchor_spl::token_interface::burn; fn planted(c: CpiContext<anchor_spl::token_interface::Burn>) { burn(c, 1).unwrap(); }'
  'fn planted(c: CpiContext<anchor_spl::token::Transfer>) { anchor_spl::token::transfer(c, 1).unwrap(); }'
  'use anchor_spl::token::close_account; fn planted(c: CpiContext<anchor_spl::token::CloseAccount>) { close_account(c).unwrap(); }'
  'use anchor_lang::solana_program::program::invoke_signed; fn planted(ix: &anchor_lang::solana_program::instruction::Instruction) { invoke_signed(ix, &[], &[]).unwrap(); }'
)
for plant in "${plants[@]}"; do
  cp "$work/original.rs" "$target"
  printf '\n%s\n' "$plant" >> "$target"
  if lint "$work/program"; then fail "the lint accepted: $plant"; fi
done
echo "check-payouts.test.sh: ok"
