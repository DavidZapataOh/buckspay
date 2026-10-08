import { encodeJoin } from '../../../protocol'
import type { NettingStatement } from '../../../protocol'
import { MessageKind } from '../../../transport/types'
import { chain, party } from '../../debts/testing'
import type { Proposal, SessionMessage, SignedJoin, TabEntry } from '../messages'

const filled = (length: number, value: number) => new Uint8Array(length).fill(value)

const signedJoin = (seed: number): SignedJoin => {
  const who = party(seed)
  const body = encodeJoin({ session: filled(32, 9), ephemeral: filled(32, seed), key: who.key })
  return { body, signature: who.sign(body) }
}

const statement = (n: number): NettingStatement => ({
  session: filled(32, 9),
  mint: filled(32, 3),
  participants: n,
  total: 12_000_000n,
  expires: 1_900_000_000,
  root: filled(32, 1),
  ephemeral: Array.from({ length: n }, (_, i) => filled(32, 0x40 + i)),
})

const tabEntry = (seed: number): TabEntry => {
  const [state] = chain([{ seq: 1, debtor: party(seed), creditor: party(seed + 1), amount: 5_000_000n }])
  return { state, salt: filled(32, seed), debt: 5_000_000n, peerOwesSender: seed % 2 === 0, pending: seed % 3 === 0 }
}

const proposal = (n: number): Proposal => ({
  statement: statement(n),
  digests: Array.from({ length: 8 }, (_, i) => filled(32, 0x10 + i)),
  slots: [
    { slot: 0, baseSeq: 1, cancel: 1_000_000n },
    { slot: 5, baseSeq: 3, cancel: 2n },
  ],
})

/** Fixed instances of every live message type, built with the real codecs. */
export const sample = {
  participants: 5,
  roster: (n: number): SessionMessage => ({
    type: 'Roster',
    entries: Array.from({ length: n }, (_, i) => ({ index: i, join: signedJoin(20 + i) })),
  }),
  tabs: (c: number): SessionMessage => ({
    type: 'Tabs',
    tabs: Array.from({ length: c }, (_, i) => tabEntry(30 + 2 * i)),
  }),
  proposal: (n: number): SessionMessage & { type: 'Proposal' } => ({ type: 'Proposal', proposal: proposal(n) }),
  final: (n: number): SessionMessage => ({
    type: 'Final',
    signatures: Array.from({ length: n }, (_, i) => filled(64, 0x70 + i)),
    proof: filled(256, 0x55),
  }),
  all(): SessionMessage[] {
    return [
      { type: 'Join', join: signedJoin(19) },
      sample.roster(3),
      sample.tabs(2),
      sample.proposal(sample.participants),
      { type: 'Approve', signature: filled(64, 0x66) },
      sample.final(sample.participants),
      { type: 'Abort', reason: 3 },
      { type: 'Relay', from: 1, to: 2, kind: MessageKind.Payment, payload: filled(12, 4) },
      { type: 'Simplify', transfers: [{ payer: 0, payee: 3, amount: 5_000_000n, via: [1] }] },
      { type: 'SimplifyApprove', approved: [0] },
    ]
  },
}
