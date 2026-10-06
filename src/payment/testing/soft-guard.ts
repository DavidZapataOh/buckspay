import { p256 } from '@noble/curves/nist.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  content,
  encodeIssueBody,
  encodeSpendBody,
  envelope,
  type Issue,
  interval,
  issueSlot,
  type Output,
  type Signed,
  type Spend,
} from '../../protocol'
import { NOTE_DOMAIN, type Party } from './world'

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])

/**
 * Test double for `signIssue`: a software key with the rule the native guard keeps for issues. It signs the
 * same content again, refuses another content for the same slot and an interval that starts before the last
 * one ended, and counts its signatures.
 */
export function createSoftSigner(payer: Party) {
  const lastEnd = new Map<number, bigint>()
  const signed = new Map<string, Uint8Array>()
  let signatures = 0
  return {
    get signatures() {
      return signatures
    },
    sign: async (issue: Issue): Promise<Uint8Array> => {
      const [start, end] = interval(issue)
      const slot = issueSlot(issue.lockSeq, start, end)
      const key = `${issue.lockSeq}:${start}:${end}`
      const hash = content(encodeIssueBody(issue))
      const known = signed.get(key)
      if (known && !same(known, hash)) throw new Error('ERR_EQUIVOCATION')
      if (!known && start < (lastEnd.get(issue.lockSeq) ?? 0n)) throw new Error('ERR_EQUIVOCATION')
      signed.set(key, hash)
      lastEnd.set(issue.lockSeq, end > (lastEnd.get(issue.lockSeq) ?? 0n) ? end : (lastEnd.get(issue.lockSeq) ?? 0n))
      signatures++
      return p256.sign(envelope(NOTE_DOMAIN, slot, hash), payer.secret, {
        prehash: true,
        lowS: true,
        format: 'compact',
      })
    },
  }
}

/**
 * Test double for `signSpend` of `src/keys`: a software key that keeps the guard's rule for spends, the same
 * content again signs and another content for one input throws, and counts its signatures.
 */
export function createSoftSpendSigner(owner: Party) {
  const signed = new Map<string, Uint8Array>()
  let signatures = 0
  return {
    get signatures() {
      return signatures
    },
    signSpend: async (input: Output, spend: Spend): Promise<Signed<Spend>> => {
      const hash = content(encodeSpendBody(spend))
      const key = bytesToHex(input.id)
      const known = signed.get(key)
      if (known && !same(known, hash)) throw new Error('ERR_EQUIVOCATION')
      signed.set(key, hash)
      signatures++
      return {
        message: spend,
        signature: p256.sign(envelope(NOTE_DOMAIN, input.id, hash), owner.secret, {
          prehash: true,
          lowS: true,
          format: 'compact',
        }),
      }
    },
  }
}
