import { utf8ToBytes } from '@noble/hashes/utils.js'
import type { Owner } from '../protocol'
import { MAX_MEMO_BYTES, PaymentError, type PaymentRequest } from './messages'

export type RequestInput = {
  amount: bigint
  memo: string
  owner: Owner
  mint: Uint8Array
  attesters: readonly number[]
  now: number
  /** How many more times the note must be passable; 1 unless the receiver wants to pass it on. */
  minHops?: number
  limits: { maxPayment: bigint; minWindow: number }
}

/** The longest prefix of `text` that is at most `MAX_MEMO_BYTES` of UTF-8, cut between characters. */
function fitMemo(text: string): string {
  let out = ''
  for (const character of text) {
    if (utf8ToBytes(out + character).length > MAX_MEMO_BYTES) break
    out += character
  }
  return out
}

/** Throws `PaymentError('Malformed')` for an amount of zero or above the maximum, or for no attester. */
export function buildRequest({
  amount,
  memo,
  owner,
  mint,
  attesters,
  now,
  minHops = 1,
  limits,
}: RequestInput): PaymentRequest {
  if (amount <= 0n || amount > limits.maxPayment || attesters.length === 0) throw new PaymentError('Malformed')
  return {
    owner,
    mint,
    amount,
    now,
    minWindow: limits.minWindow,
    minHops,
    attesters: [...attesters],
    memo: fitMemo(memo),
  }
}
