import AsyncStorage from '@react-native-async-storage/async-storage'
import { bytesToHex } from '@noble/hashes/utils.js'
import { type Address, type GetAccountInfoApi, getBase64Encoder, getProgramDerivedAddress, type Rpc } from '@solana/kit'
import type { ReceiveGate } from '../../payment/receive'
import { Reason } from '../../payment/reasons'
import { coversExpected, recordFee } from './mint'

/**
 * Refuses a note whose private settlement would pay less than the receiver asked for: each spend of its chain costs
 * the record fee of the mint, and a sender can add spends until nothing is left. A note nobody else held settles in
 * the clear and pays no such fee. With no fee known, the check cannot be made and the note is admitted.
 */
export function feeGate({
  fee,
  expected,
}: {
  fee: (mint: Uint8Array) => Promise<bigint | undefined>
  expected: bigint
}): ReceiveGate {
  return {
    async admit(received, bundle) {
      const hops = bundle.spends.length
      if (hops === 0) return null
      const unit = await fee(received.mint)
      if (unit === undefined) return null
      return coversExpected(received.output.amount, expected, unit, hops) ? null : Reason.BelowNet
    },
  }
}

const cacheKey = (mint: Uint8Array) => `zk:record-fee-v1:${bytesToHex(mint)}`

/** The record fee of a mint: read from its `ZkMint` account when online and remembered for when it is not. */
export function recordFeeSource(rpc: Rpc<GetAccountInfoApi>, programAddress: Address) {
  return async (mint: Uint8Array): Promise<bigint | undefined> => {
    try {
      const [account] = await getProgramDerivedAddress({
        programAddress,
        seeds: [new TextEncoder().encode('zk-mint'), mint],
      })
      const { value } = await rpc.getAccountInfo(account, { encoding: 'base64', commitment: 'confirmed' }).send()
      if (!value) return undefined
      const fee = recordFee(Uint8Array.from(getBase64Encoder().encode(value.data[0])))
      await AsyncStorage.setItem(cacheKey(mint), fee.toString())
      return fee
    } catch {
      const remembered = await AsyncStorage.getItem(cacheKey(mint)).catch(() => null)
      return remembered === null ? undefined : BigInt(remembered)
    }
  }
}
