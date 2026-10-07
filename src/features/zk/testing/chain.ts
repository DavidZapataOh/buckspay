import { forHolder, NO_LOCK, type Spend, walkChain } from '../../../protocol'
import { passedThrough } from '../../../payment/testing/chain'
import { NOTE_DOMAIN, party, signSpendWith } from '../../../payment/testing/world'
import type { NoteChain } from '../../settlement/chain'

/** A note issued to the first holder, passed along and settled by the last one to an account. */
export function settledChainFixture(holders: number): NoteChain {
  const people = Array.from({ length: holders }, (_, i) => party(i + 3))
  const { issue, spends } = passedThrough(party(1), people)
  const [input] = walkChain(NOTE_DOMAIN, issue, spends).last
  const message: Spend = {
    input: input.id,
    lockSeq: NO_LOCK,
    salt: new Uint8Array(16).fill(0xee),
    outputs: {
      type: 'one',
      owner: { type: 'account', address: new Uint8Array(32).fill(9) },
      caveats: {
        ...forHolder(input.caveats, { type: 'device', key: people[holders - 1].key }),
        hopsLeft: input.caveats.hopsLeft - 1,
      },
    },
  }
  return { issue, spends: [...spends, { message, signature: signSpendWith(people[holders - 1], input, message) }] }
}
