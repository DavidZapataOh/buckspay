#!/usr/bin/env bash
# Exports the Android bundle without EXPO_PUBLIC_E2E and fails if any test-only code is in it.
set -euo pipefail
work=$(mktemp -d); out=$work/dist
trap "rm -rf $work" EXIT
env -u EXPO_PUBLIC_E2E pnpm exec expo export --platform android --output-dir "$out" >"$work/export.log" 2>&1 || { tail -20 "$work/export.log"; exit 1; }
bundle=$(find "$out" -name "*.hbc" -o -name "*.js" | head -1)
for marker in NFCLAB NEARBYLAB PAYTRACE module-runner buckspay-e2e; do
  if grep -aq "$marker" "$bundle"; then echo "production bundle contains $marker"; exit 1; fi
done
