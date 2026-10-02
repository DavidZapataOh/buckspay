# buckspay-protocol

The Buckspay offline note format, version 1. `no_std`; hashing uses the `sol_sha256` syscall on Solana and the `sha2` crate elsewhere. The `verify` feature adds P-256 and Ed25519 verification for off-chain use: signatures, conflict proofs and the acceptance of a received payment.

## Domains, envelope and identifiers

```
DOMAIN(purpose) = SHA256("BUCKSPAY:v1:" ‖ purpose ‖ genesis_hash[32] ‖ program_id[32])   never transmitted
CONTENT         = SHA256(body)
ENVELOPE        = DOMAIN(note) ‖ SLOT ‖ CONTENT                                         96 bytes, signed with P-256
e               = SHA256(ENVELOPE)                                                       message id
output          = SHA256("BPO1" ‖ e ‖ index:u8)                                          output id
scope_hash      = SHA256("BPS1" ‖ owner[33])[..20]
```

Purposes: `note` (issues and spends), `ticket` (bond tickets, Ed25519), `device` (device registration), `witness` (co-presence witness), `reclaim` (reclaiming an unsettled output), `payword`, `iou`, `voice` (voice-envelope share claims) and `claim` (loss-claim payout authorizations). Every P-256 signature is over a 96-byte envelope under its own purpose, so a signature made for one purpose never verifies as another. A new signed kind takes a new purpose. The devnet and mainnet genesis hashes are constants in `cluster`; they are never read from an RPC node.

`SLOT` for a spend is the consumed output id. `SLOT` for an issue is `"ISSU" ‖ lock_seq:u32 ‖ start:u64 ‖ end:u64 ‖ 0x00×8`, where `[start, end) = [cum_end − amount, cum_end)` is the interval of the issuer's lock that the issue claims. `lock_seq` is global per device, across mints.

The per-hop nullifier is the consumed output id. Settlement is a spend to an account owner, so every consumed output has a `CONTENT`.

## Encoding rules

- Integers are little-endian. SEC1 keys and ECDSA `r‖s` are big-endian.
- Amounts are `u64` minor units of the note's mint. Times are `u32` Unix seconds.
- Every message has a fixed size per kind. Decoders reject any other length, unknown versions, unknown kinds, reserved owner types, unknown flag bits, non-canonical scopes and unknown recovery bits.
- P-256 signatures are 64-byte `r‖s` over SHA-256 of the envelope, with low S. Verifiers reject high S.
- An implementation whose types do not fix widths rejects an out-of-range integer, or a key, account address, scope, mint, salt, input or signature of the wrong length, with `Length`.

## Fields

| Field        | Size | Encoding                                                                                                              |
| ------------ | ---- | --------------------------------------------------------------------------------------------------------------------- |
| `owner`      | 33   | `0x02`/`0x03` ‖ x: P-256 device key (SEC1 compressed). `0x00` ‖ 32 bytes: terminal Solana account. `0x01` reserved    |
| `caveats`    | 27   | `expiry:u32 ‖ hops_left:u8 ‖ flags:u8 ‖ scope_kind:u8 ‖ scope[20]`                                                    |
| `flags`      |      | bit 0 `DELEGATED`, bit 1 `AUTHORITY_ONLY` (set only by the issuer, requires an authority scope); other bits must be 0 |
| `scope_kind` |      | 0 any (scope all zero), 1 merchant (`scope_hash`), 2 category (`u16` code, then zeros), 3 authority (`scope_hash`)    |

An issue's `hops_left` is at most 16, and an issue always names a lock: `lock_seq = 0xFFFFFFFF` is reserved for spends. The authority is always a terminal account: an issue or spend whose output's authority scope names that output's own owner must give it an account owner.

## Messages

| Kind   | Message       | Body (hashed into `CONTENT`)                                                                                              | Wire                                                                                         |
| ------ | ------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `0x01` | Issue         | `ver ‖ kind ‖ issuer[33] ‖ mint[32] ‖ lock_seq:u32 ‖ cum_end:u64 ‖ salt[16] ‖ owner[33] ‖ amount:u64 ‖ caveats[27]` (163) | body ‖ sig (227)                                                                             |
| `0x02` | Spend1        | `ver ‖ kind ‖ lock_seq:u32 ‖ salt[16] ‖ owner[33] ‖ caveats[27]` (82)                                                     | input[32] ‖ body ‖ sig (178)                                                                 |
| `0x03` | Spend2        | `ver ‖ kind ‖ lock_seq:u32 ‖ salt[16] ‖ owner0[33] ‖ amount0:u64 ‖ caveats0[27] ‖ owner1[33]` (123)                       | input[32] ‖ body ‖ sig (219)                                                                 |
| `0x10` | BondTicket    | `ver ‖ kind ‖ device[33] ‖ mint[32] ‖ lock_seq:u32 ‖ bond:u64 ‖ backing:u64 ‖ lock_until:u32 ‖ attester:u16` (93)         | body ‖ Ed25519 sig over `DOMAIN(ticket) ‖ body` (157)                                        |
| `0x20` | SpendConflict |                                                                                                                           | `ver ‖ kind ‖ slot[32] ‖ content_a[32] ‖ sig_a ‖ content_b[32] ‖ sig_b ‖ recovery` (227)     |
| `0x21` | IssueConflict |                                                                                                                           | `ver ‖ kind ‖ (lock_seq:u32 ‖ start:u64 ‖ end:u64 ‖ content[32] ‖ sig) × 2 ‖ recovery` (235) |
| `0x50` | DeviceBinding | `ver ‖ kind ‖ wallet[32] ‖ key[33]` (67), signed under `DOMAIN(device)` with `SLOT` = wallet                              | none: the signature travels in a secp256r1 verification instruction                          |

`recovery = recid_a | recid_b << 2`: the signer's key is recovered from both signatures, which must agree.

Reserved kinds: `0x01–0x0F` notes, `0x10–0x1F` tickets, `0x20–0x2F` conflicts, `0x30` IOU, `0x40` PayWord, `0x50` device binding.

## Spends

- `Spend1` pays the whole input to `owner`. `Spend2` pays `amount0` (`0 < amount0 < input`) to `owner0` and returns `input − amount0` to the spender: `owner1` must be the input's owner, and the change keeps the input's caveats with one hop less. `Spend2` needs an input with at least two hops left, so change can always move again.
- Output 0 (the child) is valid only if, against the consumed output (the parent): `child.expiry ≤ parent.expiry`; `parent.hops_left ≥ 1` and `child.hops_left ≤ parent.hops_left − 1`; `child.flags ∩ STICKY = parent.flags ∩ STICKY` (`STICKY = AUTHORITY_ONLY`, so only the issuer sets it); a parent scope of `any` permits any child scope, otherwise the child's scope kind and bytes are equal.
- A merchant or authority scope admits only an `owner0` whose `scope_hash` equals the scope. Once the holder is the merchant, the merchant scope no longer binds its spends: it may pay anyone, including its own account, with any caveats the rules above otherwise permit. An authority scope is never lifted: the authority is a terminal account, whose outputs are never spent. A category scope needs the category registry and is not checked offline.
- `lock_seq` names the spender's bond lock. `0xFFFFFFFF` (no lock) is allowed only when the consumed output is `DELEGATED` or carries `AUTHORITY_ONLY`, or when the spend is a `Spend1` to a terminal account (a settlement, so a holder without a bond can always settle what it accepted), and output 0 of such a spend is never `DELEGATED`. A spend without a lock of a delegated output is backed by the lock of the nearest earlier spend that names one, or by the issuer's lock when none does; one of an `AUTHORITY_ONLY` note is backed by the issuer's lock. A settlement without a lock of any other output is backed by no lock, so no receiver accepts it offline.
- `salt` is random per spend, so a `CONTENT` cannot be matched against guessed bodies.
- An output owned by a terminal account cannot be spent. A closed-circuit authority is such an account: a payment to it is settled on chain.

## Receiving a payment

A receiver accepts an issue, at most 16 spends and the bond tickets of the issuer and every spender that names a lock, at most one per message and one per lock, only if all signatures verify; no consumed output has expired; every ticket is signed by a known attester under `DOMAIN(ticket)`, names the right device, lock and mint, and is locked until at least `expiry + GRACE + CHALLENGE`; the issuer's `bond` covers the issue's amount and its `backing` covers the issue's `cum_end` (a delegated issue is the issuer's liability, so this covers it too); and every locked spender's `bond` covers the amount it spent. A ticket for a lock the chain does not use is ignored.

The payment is output 0 of the last message, never change. It must be owned by the receiver, and the receiver must be able to redeem it: once a merchant scope naming the receiver is lifted, its scope must be `any`, an authority scope naming the receiver's account, an `AUTHORITY_ONLY` note of an authority a receiving device has chosen to trust, named by the authority's account address (the device can pay the note only to that authority), or a category the receiver has chosen to check itself. Its last spend, when it names no lock, must consume a `DELEGATED` or `AUTHORITY_ONLY` output. It must have at least `min_window` seconds before its expiry; an output owned by a device also needs a hop left, while an output owned by a terminal account needs none. The result lists the distinct locks liable for the payment with their bonds, in chain order: the issuer's, then each lock a spender named. Verification is stateless: a wallet records every output id it accepted and every slot it saw consumed, and rejects repeats.

An Ed25519 ticket signature counts only when the attester key and the signature's `R` are canonical encodings of points in the prime-order subgroup and the strict (cofactorless) equation holds. With both points torsion-free the cofactored and cofactorless equations agree, so every verifier, including the Ed25519 precompile, reaches the same answer. An attester key with a torsion component is never registered.

## Settling

A chain whose last output 0 is a terminal account is settled on chain with the same chain checks and no tickets: the program bounds settlement by that output's expiry and slashes locks on conflict.

A holder checks its own spend before signing it with `check_spend_step`: the rules of one hop, and a consumed output that can still move, as a payment until its expiry and as a settlement until `expiry + GRACE`.

`expiry` is the last time an output can be accepted offline. Its payee can settle it until `expiry + GRACE`, and conflicts are accepted until `expiry + GRACE + CHALLENGE`. `GRACE` and `CHALLENGE` are 7 days each.

## Fraud

- **Equivocation:** two valid signatures by the same key over envelopes with the same `SLOT` and different `CONTENT`. Conflicts compare `CONTENT`, never signature bytes, so a malleated copy of one signature proves nothing.
- **Over-issuance:** two issue slots of the same issuer and `lock_seq` whose intervals overlap, with different `CONTENT`.

## Known limits

- One key's fraud across all its outputs, and over-issuance on its lock, is covered only while the total stays within its bond, not per output. Beyond that, loss is bounded by receiver caps and by how fast conflicts spread. A receiver accepts a payment only up to the bond of every lock backing it, and the result names those locks, so a wallet keeps a cumulative cap per lock across the payments it accepts.
- Tickets do not reflect a slash already applied to their lock.
- A note that may only reach the authority can be spent without a lock. A double spend of it to two points of sale before they sync is slashed from the issuer's lock, within the limit above. Until its points of sale sync, the organiser of a closed circuit bears its attendees' double spends, up to the number of offline points of sale times the note's amount.
- Trust is keyed by the authority, not the issuer: any bonded issuer can issue notes redeemable at an authority a device trusts, each backed by that issuer's own lock.
- A holder without a bond settles to an account without a lock. If it settles one output to two accounts, only the first lands on chain, and no receiver accepted the other offline.
- A device accepts a note that may only reach the authority only if it trusts that authority, and can then spend it only there; a wallet shows the holder where such a note is redeemable. Only a receiver that checks categories accepts a category-scoped note.
- Gossip keeps conflict flags only for keys already seen in chains or on chain, since anyone can make a conflict for a fresh key.
- A wallet persists the exact envelope before it signs and the signature right after, and only ever re-sends those bytes, so an interrupted transfer is never re-signed to a different payee.
- A payee must settle before `expiry + GRACE`. After that, the owner may reclaim the output with a `reclaim` signature.
- An issuer records `cum_end` for each lock before it signs an issue, in storage that is excluded from backups.
- Attesters are trusted to sign true tickets and are slashable when they do not.

## Test vectors

`tests/vectors/v1.json` holds golden vectors shared with the TypeScript implementation in `src/protocol`. The keys in it are fixed test keys and control nothing. After changing the format, regenerate them:

```bash
cargo run -p buckspay-protocol --example vectors --features verify
```
