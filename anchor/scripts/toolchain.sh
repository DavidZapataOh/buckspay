#!/usr/bin/env bash
# Source this file. Puts the Agave 4.3.0 tools first on PATH and refuses any other Solana CLI,
# because the default `solana` on a machine can be an older release (3.1.10 on the build server).
AGAVE_VERSION="4.3.0"
export PATH="$HOME/.local/share/solana/install/releases/$AGAVE_VERSION/solana-release/bin:$HOME/.cargo/bin:$PATH"
case "$(solana --version 2>/dev/null)" in
  "solana-cli $AGAVE_VERSION "*) ;;
  *)
    echo "toolchain: expected solana-cli $AGAVE_VERSION, found: $(solana --version 2>&1 | head -1)" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac
