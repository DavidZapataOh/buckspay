import { fetchMaybeRotation, findRotationPda } from '@project/anchor'
import type { Address } from '@solana/kit'

/** A move of this phone's registration to another wallet that is waiting out its veto window. */
export type RotationAlert = { address: Address; newWallet: Address; payer: Address; effectiveAt: number }

/**
 * The wallet rotation pending on `key`, if any. The app never asks for a rotation, so a pending one
 * was requested by someone else and the wallet can cancel it until it takes effect.
 */
export async function readPendingRotation(
  rpc: Parameters<typeof fetchMaybeRotation>[0],
  programAddress: Address,
  key: Uint8Array,
): Promise<RotationAlert | undefined> {
  const [address] = await findRotationPda(key, programAddress)
  const rotation = await fetchMaybeRotation(rpc, address, { commitment: 'confirmed' })
  if (!rotation.exists) return undefined
  const { wallet: newWallet, payer, effectiveAt } = rotation.data
  return { address, newWallet, payer, effectiveAt }
}
