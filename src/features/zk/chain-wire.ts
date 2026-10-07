import { equalBytes } from '@noble/curves/utils.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { content, encodeCaveats, encodeIssueBody, type Output, walkChain } from '../../protocol'
import type { NoteChain } from '../settlement/chain'

const MAX_MESSAGES = 17
const OPENING_BYTES = 33 + 8 + 27 + 16 + 1

const u16 = (n: number) => Uint8Array.of(n >> 8, n & 0xff)
const u64 = (n: bigint) => {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, n)
  return out
}

/** What the gateway reads of a chain besides its proofs; the keys and bodies of the holders stay out. */
export type ZkChain = {
  issuerKey: Uint8Array
  lockSeq: number
  amount: bigint
  cumEnd: bigint
  /** What the last message pays, its expiry and the account it pays. */
  payAmount: bigint
  expiry: number
  payee: Uint8Array
  messages: { content: Uint8Array; nextBit: 0 | 1 }[]
}

type Step = {
  body: Uint8Array
  key: Uint8Array
  signature: Uint8Array
  consumed?: { output: Output; index: 0 | 1; salt: Uint8Array }
}

function steps(domain: Uint8Array, { issue, spends }: NoteChain) {
  if (spends.length === 0 || spends.length >= MAX_MESSAGES) throw new Error('A private chain has 1 to 16 spends.')
  const walk = walkChain(domain, issue, spends)
  const out: Step[] = [{ body: encodeIssueBody(issue.message), key: walk.entries[0].key, signature: issue.signature }]
  spends.forEach((spend, i) => {
    const before = walkChain(domain, issue, spends.slice(0, i)).last
    const index = before.findIndex((output) => equalBytes(output.id, spend.message.input))
    const salt = i === 0 ? issue.message.salt : spends[i - 1].message.salt
    out.push({
      body: walk.links[i].body,
      key: walk.entries[i + 1].key,
      signature: spend.signature,
      consumed: { output: before[index], index: index as 0 | 1, salt },
    })
  })
  return { out, last: walk.last[0] }
}

/**
 * The chain as the prover reads it: domain, message count, each message (kind, body length, body, r, s,
 * signer key), then for each message the output of the previous one it consumes (owner, amount, caveats,
 * salt of the message that made it, which of its outputs). The issue consumes nothing: zeros.
 */
export function encodeProverChain(domain: Uint8Array, chain: NoteChain): Uint8Array {
  const { out } = steps(domain, chain)
  const parts: Uint8Array[] = [domain, Uint8Array.of(out.length)]
  for (const { body, key, signature } of out) parts.push(Uint8Array.of(body[1]), u16(body.length), body, signature, key)
  for (const { consumed } of out) {
    if (!consumed) {
      parts.push(new Uint8Array(OPENING_BYTES))
      continue
    }
    const { output, index, salt } = consumed
    if (output.owner.type !== 'device') throw new Error('An intermediate output belongs to a device key.')
    parts.push(output.owner.key, u64(output.amount), encodeCaveats(output.caveats), salt, Uint8Array.of(index))
  }
  return concatBytes(...parts)
}

/** The public facts of the chain the settlement request carries. */
export function zkChain(domain: Uint8Array, chain: NoteChain): ZkChain {
  const { out, last } = steps(domain, chain)
  if (last.owner.type !== 'account') throw new Error('A settlement pays an account.')
  return {
    issuerKey: chain.issue.message.issuer,
    lockSeq: chain.issue.message.lockSeq,
    amount: chain.issue.message.amount,
    cumEnd: chain.issue.message.cumEnd,
    payAmount: last.amount,
    expiry: last.caveats.expiry,
    payee: last.owner.address,
    messages: out.map(({ body }, i) => ({ content: content(body), nextBit: out[i + 1]?.consumed?.index ?? 0 })),
  }
}
