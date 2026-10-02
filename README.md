# Buckspay

Offline bearer payments on Solana for Android. Built with Expo, Anchor and Mobile Wallet Adapter.

## Requirements

- Node 22.13 or later and pnpm 12 (`corepack enable`)
- Rust (the program workspace pins its toolchain), [Agave CLI 4.3.0](https://docs.anza.xyz/cli/install) and [Anchor CLI 1.2.0](https://www.anchor-lang.com/docs/installation)
- Android SDK and a physical Android device for development builds
- [gitleaks](https://github.com/gitleaks/gitleaks) for the pre-commit secret scan

## Setup

```bash
pnpm install
```

A fresh clone needs no keypair: `pnpm install`, `pnpm android` and `pnpm anchor:test` build and test as is.

`pnpm anchor:setup` is only for maintainers who hold the program keypair. It expects the keypair at `~/.config/buckspay/buckspay-keypair.json`, syncs the program id, builds the program and regenerates the TypeScript client.

## Develop

```bash
pnpm android        # development build on a connected device
pnpm dev            # Metro for the development build
pnpm anchor:test    # build the program and run its LiteSVM tests
```

After changing the program, run `pnpm anchor:build && pnpm codama:js`. The generated client in `anchor/src/client/js/generated` is never edited by hand.

## Checks

```bash
pnpm run ci
```

## License

Apache-2.0
