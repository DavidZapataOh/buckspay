import { equalBytes } from '@noble/curves/utils.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import {
  type GetAccountInfoApi,
  type GetBlockTimeApi,
  getAddressDecoder,
  getBase64Encoder,
  type Rpc,
} from '@solana/kit'
import { GRACE } from '../../protocol'
import { recordAddress } from '../../protocol/record'
import type { OutboxRow } from '../relay/outbox'
import type { RelayAnswer } from '../relay/seal'

/** Seconds past the window the gateway still lets a settlement start in: a record cannot appear later than this. */
export const MARGIN = 120

export type RemoteState = 'signed' | 'received' | 'relaying' | 'delivered' | 'expired' | 'refused'

export type RemoteEvent =
  | { type: 'stored'; by: 'carrier' | 'relayer'; at: number }
  | { type: 'answer'; answer: RelayAnswer; at: number }
  | {
      type: 'chain'
      record: 'ours' | 'other' | 'none'
      commitment: 'finalized' | 'confirmed' | 'processed'
      blockTime: number
      expiry: number
    }

const FINAL_REASONS = ['invalid', 'window', 'conflict', 'lock']
const RANK = { signed: 0, received: 1, relaying: 2 } as const
const forward = (from: 'signed' | 'received' | 'relaying', to: keyof typeof RANK): RemoteState =>
  RANK[to] > RANK[from] ? to : from

/**
 * The state after an event: forward only. `delivered`, `expired` and `refused` are final; `expired` comes only from a
 * finalized read of the cluster whose block time is past the last moment a record could still be written.
 */
export function nextState(state: RemoteState, event: RemoteEvent): RemoteState {
  if (state === 'delivered' || state === 'expired' || state === 'refused') return state
  switch (event.type) {
    case 'stored':
      return forward(state, 'received')
    case 'answer': {
      const { answer } = event
      if (answer.status === 'settled') return 'delivered'
      if (answer.status === 'submitted' || answer.status === 'duplicate') return forward(state, 'relaying')
      if (answer.status === 'refused' && FINAL_REASONS.includes(answer.reason)) return 'refused'
      return state
    }
    case 'chain':
      if (event.record === 'ours') return 'delivered'
      if (event.record === 'other') return 'refused'
      return event.commitment === 'finalized' && event.blockTime > event.expiry + GRACE + MARGIN ? 'expired' : state
  }
}

const SPENT_CONTENT = 8
const SPENT_FLAGS = 80
const RECLAIMED = 2
const READS = 3

/**
 * Reads the record of the output of an outbox row at `finalized` and stamps the event with the time of the block of the
 * slot the read came from: the phone's clock is never used. A slot with no block time is read again; after three
 * tries the event is not final enough to expire anything.
 */
export async function checkDelivery(
  rpc: Rpc<GetAccountInfoApi & GetBlockTimeApi>,
  row: OutboxRow,
  program: Uint8Array,
): Promise<RemoteEvent> {
  const at = recordAddress(program, hexToBytes(row.ref))
  if (!at) throw new Error('The output of a payment this phone made has no record address.')
  const expiry = row.expiresAt - GRACE
  const programAddress = getAddressDecoder().decode(program)
  for (let attempt = 0; attempt < READS; attempt++) {
    const { context, value } = await rpc
      .getAccountInfo(getAddressDecoder().decode(at), { commitment: 'finalized', encoding: 'base64' })
      .send()
    if (value && value.owner === programAddress) {
      const data = getBase64Encoder().encode(value.data[0])
      const same = row.content !== null && equalBytes(data.slice(SPENT_CONTENT, SPENT_CONTENT + 32), row.content)
      const reclaimed = (data[SPENT_FLAGS] & RECLAIMED) !== 0
      return {
        type: 'chain',
        record: same && !reclaimed ? 'ours' : 'other',
        commitment: 'finalized',
        blockTime: 0,
        expiry,
      }
    }
    const time: bigint | null = await rpc
      .getBlockTime(context.slot)
      .send()
      .catch(() => null)
    if (time !== null)
      return { type: 'chain', record: 'none', commitment: 'finalized', blockTime: Number(time), expiry }
  }
  return { type: 'chain', record: 'none', commitment: 'processed', blockTime: 0, expiry }
}
