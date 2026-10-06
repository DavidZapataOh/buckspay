import { fetchMaybeAttester, fetchMaybeLedger, findLedgerPda } from '@project/anchor'
import {
  type Address,
  type GetAccountInfoApi,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU16Encoder,
  type Rpc,
} from '@solana/kit'
import type { RegistryRead } from './registry'

/**
 * What one provider says about attester `id` at `confirmed`: its registry entry and the bond free in
 * its ledger, which is its stake. `undefined` when it is not registered.
 */
export async function readRegistryEntry(
  rpc: Rpc<GetAccountInfoApi>,
  programAddress: Address,
  id: number,
): Promise<RegistryRead | undefined> {
  const [attesterAddress] = await getProgramDerivedAddress({
    programAddress,
    seeds: [new TextEncoder().encode('attester'), getU16Encoder().encode(id)],
  })
  const [ledgerAddress] = await findLedgerPda({ lock: attesterAddress }, { programAddress })
  const [attester, ledger] = await Promise.all([
    fetchMaybeAttester(rpc, attesterAddress, { commitment: 'confirmed' }),
    fetchMaybeLedger(rpc, ledgerAddress, { commitment: 'confirmed' }),
  ])
  if (!attester.exists || !ledger.exists) return undefined
  const encoder = getAddressEncoder()
  const { authority, mint, key, prevKey, prevTrustedUntil, status } = attester.data
  return {
    authority: Uint8Array.from(encoder.encode(authority)),
    mint: Uint8Array.from(encoder.encode(mint)),
    key: Uint8Array.from(key),
    prevKey: Uint8Array.from(prevKey),
    prevTrustedUntil,
    status,
    bondFree: ledger.data.bondFree,
  }
}
