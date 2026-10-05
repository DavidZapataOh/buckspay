import { fetchAllMaybeLock, findLockPda, getLedgerDecoder, getLedgerSize, type Ledger } from '@project/anchor'
import {
  type Address,
  getBase58Decoder,
  getBase64Encoder,
  type GetMultipleAccountsApi,
  type GetProgramAccountsApi,
  type Rpc,
} from '@solana/kit'
import type { Windows } from '../../protocol'

/** A lock of this device key: what its ledger holds and when it ends. */
export type LockRecord = Pick<
  Ledger,
  'backingLeft' | 'bondFree' | 'bondSlashed' | 'payer' | 'lockSeq' | 'withdrawn'
> & {
  address: Address
  mint: Address
  bond: bigint
  backing: bigint
  /** Unix seconds. */
  lockUntil: number
}

const KEY_OFFSET = 64n

/**
 * The locks of `key`, oldest first: its ledgers are found by the key they store and each lock
 * account is read beside it, so no lock number is probed.
 */
export async function readLocks(
  rpc: Rpc<GetProgramAccountsApi & GetMultipleAccountsApi>,
  programAddress: Address,
  key: Uint8Array,
): Promise<LockRecord[]> {
  const entries = await rpc
    .getProgramAccounts(programAddress, {
      commitment: 'confirmed',
      encoding: 'base64',
      filters: [
        { dataSize: BigInt(getLedgerSize()) },
        { memcmp: { offset: KEY_OFFSET, bytes: getBase58Decoder().decode(key) as never, encoding: 'base58' } },
      ],
    })
    .send()
  const ledgers = entries
    .map(({ account }) => getLedgerDecoder().decode(getBase64Encoder().encode(account.data[0])))
    .sort((a, b) => a.lockSeq - b.lockSeq)
  const addresses = await Promise.all(
    ledgers.map(async ({ lockSeq }) => (await findLockPda(key, lockSeq, programAddress))[0]),
  )
  const locks = await fetchAllMaybeLock(rpc, addresses, { commitment: 'confirmed' })
  return ledgers.flatMap((ledger, i) => {
    const lock = locks[i]
    if (!lock.exists) return []
    const { mint, bond, backing, lockUntil } = lock.data
    const { backingLeft, bondFree, bondSlashed, payer, lockSeq, withdrawn } = ledger
    return [
      {
        address: addresses[i],
        mint,
        bond,
        backing,
        lockUntil,
        backingLeft,
        bondFree,
        bondSlashed,
        payer,
        lockSeq,
        withdrawn,
      },
    ]
  })
}

/** The Unix time from which the wallet can take a lock's remainder. */
export const withdrawalOpensAt = ({ lockUntil }: Pick<LockRecord, 'lockUntil'>, { claimWindow }: Windows) =>
  lockUntil + claimWindow

export const isWithdrawable = (lock: Pick<LockRecord, 'lockUntil' | 'withdrawn'>, windows: Windows, now: number) =>
  !lock.withdrawn && now >= withdrawalOpensAt(lock, windows)
