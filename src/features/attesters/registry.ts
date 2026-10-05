import { equalBytes } from '@noble/curves/utils.js'

import type { Attester } from '../../protocol'

/** An attester the wallet trusts: pinned in the build or chosen by the user, never inferred. */
export type TrustedAttester = { id: number; authority: Uint8Array; mint: Uint8Array }

/** What one RPC provider says about an attester's registry entry and the stake in its ledger. */
export type RegistryRead = {
  authority: Uint8Array
  mint: Uint8Array
  key: Uint8Array
  prevKey: Uint8Array
  prevTrustedUntil: number
  status: number
  bondFree: bigint
}

/** `attester_status::ACTIVE` in the program. */
const ACTIVE = 1

const same = (a: RegistryRead, b: RegistryRead) =>
  equalBytes(a.key, b.key) &&
  equalBytes(a.prevKey, b.prevKey) &&
  a.prevTrustedUntil === b.prevTrustedUntil &&
  a.status === b.status &&
  a.bondFree === b.bondFree &&
  equalBytes(a.authority, b.authority) &&
  equalBytes(a.mint, b.mint)

/**
 * The attester a wallet believes after reading its registry entry from two independent providers: only
 * if they agree on every field, and the entry's authority and mint are the ones the wallet pinned
 * (an id whose authority changed is not the attester the user trusted). `previous` carries what the
 * wallet relied on and the keys it saw revoked across the sync.
 */
export function buildAttester(
  trusted: TrustedAttester,
  a: RegistryRead,
  b: RegistryRead,
  syncedAt: number,
  previous?: Attester,
): Attester | undefined {
  if (!same(a, b)) return undefined
  if (!equalBytes(a.authority, trusted.authority) || !equalBytes(a.mint, trusted.mint)) return undefined
  return {
    id: trusted.id,
    authority: a.authority,
    mint: a.mint,
    stake: a.bondFree,
    key: a.key,
    prevKey: a.prevKey,
    prevTrustedUntil: a.prevTrustedUntil,
    revoked: previous?.revoked ?? [new Uint8Array(32), new Uint8Array(32)],
    syncedAt,
    active: a.status === ACTIVE,
    relied: previous?.relied ?? 0n,
  }
}
