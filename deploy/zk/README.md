# Trusted setup of the per-message circuit

The verifying key of the circuit comes from a two-phase Groth16 setup (BN254, `mpcsetup` of
gnark). Soundness holds as long as one contributor of each phase destroyed its randomness. A key
that fails that assumption lets its holder forge proofs.

Everything below is run with `buckspay-zk`, built from `prover/cmd/buckspay-zk`
(`cd prover && go build -o buckspay-zk ./cmd/buckspay-zk`).

## Test keys

`buckspay-zk ceremony local-test --out DIR` runs a whole ceremony on one machine with throwaway
participants and writes `manifest.json` with `"Test": true`. Whoever ran it can reconstruct the
trapdoor, so the keys prove nothing about soundness. `buckspay-zk export-vk --rust DIR/vk.bin`
reads the manifest beside the key and, for test keys, writes `TEST_KEYS = true` into the generated
file (`--test-keys` forces it); a verifier must refuse such a key on mainnet. Never pin test keys
in a release build.

## Ceremony

1. Announce the beacon slot (a mainnet slot at least 24 hours after the last planned
   contribution) in this file before the first contribution.
2. The coordinator compiles the circuit and starts phase 1:

   ```
   buckspay-zk compile --out ccs.bin
   buckspay-zk ceremony phase1-init --log2 20 --out p1-0
   ```

3. Each contributor runs, on its own machine, and returns the file and the printed hash:

   ```
   buckspay-zk ceremony phase1-contribute --in p1-K --out p1-K+1
   ```

4. After the beacon slot, with the SHA-256 of that slot's blockhash as hex:

   ```
   buckspay-zk ceremony phase1-seal --log2 20 --beacon HEX --out srs p1-1 ... p1-N
   ```

5. Phase 2 repeats the same steps on the circuit:

   ```
   buckspay-zk ceremony phase2-init --ccs ccs.bin --srs srs --out p2-0
   buckspay-zk ceremony phase2-contribute --in p2-K --out p2-K+1
   buckspay-zk ceremony phase2-seal --ccs ccs.bin --srs srs --beacon HEX --out keys p2-1 ... p2-N
   ```

   `phase2-seal` writes `pk.bin`, `pk.dump`, `vk.bin`, `ccs.bin` and `manifest.json` (every hash,
   the contribution hashes, the beacon, the constraint count).

6. Publish every phase file, the manifest and the keys under `/zk/<vk sha256>/` on the key host.
   Anyone can repeat steps 4 and 5 from the published files and must get the same keys.
7. `buckspay-zk export-vk --rust keys/vk.bin > anchor/crates/zk-verify/src/vk.rs`, and commit
   `vk.rs` together with the manifest.

Phase files, `pk.*`, `ccs.bin` and any contributor randomness are never committed.

## Keys of the tests

`buckspay-zk test-setup --out DIR` runs the single-party setup of gnark in about a minute and
stores the keys as test keys. `manifest.test.json` is the manifest of the keys the verifier crate
carries under its `test-keys` feature; the tests of the program use fixtures proved under them
(`anchor/scripts/prove-zk-fixtures.sh`). `anchor/scripts/check-program.mjs` refuses a binary that
carries these keys on mainnet.
