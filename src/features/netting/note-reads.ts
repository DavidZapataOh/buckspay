import { type Address, getAddressDecoder, getAddressEncoder } from '@solana/kit'
import { ACTIVE_PROFILE } from '../../protocol/active-profile'
import { settleDeadline } from '../../protocol/window'
import { type ChainReads } from './record'
import type { NoteStateDeps } from './remainder'

const encode = getAddressEncoder()
const decode = getAddressDecoder()

/**
 * The reads `noteState` needs, over the same finalized reads as the netting records. A record that closed leaves
 * no trace here (the signature history of closed `Spent` records is not read), so a note is never called void
 * for the absence of its record: after the settle deadline that answer is `undecided`.
 */
export function noteStateDeps(
  reads: ChainReads,
  noteDomain: Uint8Array,
  programId: Address = ACTIVE_PROFILE.programId as Address,
): NoteStateDeps {
  let lastSlot = 0n
  return {
    chain: {
      account: async (address) => {
        const read = await reads.account(decode.decode(address), 'finalized')
        lastSlot = read.slot
        return read.owner && read.data ? { slot: read.slot, owner: read.owner, data: read.data } : null
      },
      now: () => reads.blockTime(lastSlot),
    },
    programId: Uint8Array.from(encode.encode(programId)),
    noteDomain,
    settleEnd: settleDeadline,
    closableAt: (expiry) => settleDeadline(expiry) + 1,
    history: async () => [],
  }
}
