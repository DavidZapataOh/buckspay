import { bytesToHex } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  content,
  encodeIssue,
  encodeIssueBody,
  encodeSpend,
  encodeSpendBody,
  GRACE,
  type Issue,
  type Signed,
  type Spend,
  walkChain,
} from '../../protocol'
import type { Message, Transport } from '../../transport/types'
import { decodeBundle } from '../../payment/messages'
import { issueMessageId } from '../../payment/pay'
import type { NoteDb } from '../notes/db'
import { setOutgoingState } from '../notes/outgoing'
import { settlementRequest } from '../settlement/chain'
import type { SettlementRequest } from '../lock/gateway'
import type { Outcome } from '../settlement/settle'
import { SPRAY_COPIES } from '../relay/carry'
import { encodeInner } from '../relay/inner'
import { queueSealed } from '../relay/outbox'
import { loadConfig } from '../relay/config'
import { type SealedRelay, sealRelay } from '../relay/seal'

export type RemoteCtx = {
  db: NoteDb
  /** Whether this phone has validated internet right now. */
  online: boolean
  now: () => number
  noteDomain: Uint8Array
  /** Posts the chain to the gateway's settlement endpoint. */
  settleDirect: (request: SettlementRequest) => Promise<Outcome>
  /** Seals the inner message to the gateway key this build pins for `now`. */
  seal: (inner: Uint8Array, now: number) => Promise<SealedRelay>
}

export type SignedRemote = { messageId: Uint8Array; issue: Signed<Issue>; spends: Signed<Spend>[] }

/** What the payer sees after Pay: paid now, handed to the outbox, or refused for good. */
export type RemoteOutcome = 'delivered' | 'queued' | 'refused'

/** A seal that reads the gateway configuration this phone last fetched. */
export const sealWithStored = (db: NoteDb, genesisHash: Uint8Array) => async (inner: Uint8Array, now: number) =>
  sealRelay(await loadConfig(db), genesisHash, inner, now)

const ENDED = ['invalid', 'conflict', 'window', 'closed', 'deadline', 'lock_ended', 'lock']

/** The content of the last message of the chain: what the record of its output will hold. */
const lastContent = ({ issue, spends }: Pick<SignedRemote, 'issue' | 'spends'>) =>
  content(spends.length > 0 ? encodeSpendBody(spends[spends.length - 1].message) : encodeIssueBody(issue.message))

/**
 * After the payment is signed: online, the gateway settles it directly; otherwise (or when the gateway gave no
 * answer) it is sealed once into the outbox with the copies to spray. Nothing here signs.
 */
export async function sendRemote(ctx: RemoteCtx, signed: SignedRemote): Promise<RemoteOutcome> {
  const { db } = ctx
  if (ctx.online) {
    const outcome = await ctx.settleDirect(settlementRequest(signed))
    if (outcome.kind === 'sent' || outcome.kind === 'settled') {
      await setOutgoingState(db, signed.messageId, 'confirmed', ctx.now())
      return 'delivered'
    }
    if (outcome.kind === 'refused' && ENDED.includes(outcome.refusal.kind)) {
      if (outcome.refusal.kind !== 'conflict') await setOutgoingState(db, signed.messageId, 'rejected', ctx.now())
      return 'refused'
    }
  }
  const inner = encodeInner(encodeIssue(signed.issue), signed.spends.map(encodeSpend))
  const sealed = await ctx.seal(inner, ctx.now())
  const [output] = walkChain(ctx.noteDomain, signed.issue, signed.spends).last
  await queueSealed(db, {
    id: sha256(sealed.blob),
    ref: bytesToHex(output.id),
    sealed,
    now: ctx.now(),
    expiresAt: signed.issue.message.caveats.expiry + GRACE,
    remote: { messageId: signed.messageId, content: lastContent(signed), copies: SPRAY_COPIES },
  })
  return 'queued'
}

/** The part of a `Transport` that `confirmAndSend` uses: it hands the signed bundle to `sendRemote` instead of a screen. */
export function remoteSender(ctx: RemoteCtx, onOutcome: (outcome: RemoteOutcome) => void): Pick<Transport, 'send'> {
  return {
    async send({ payload }: Message) {
      const { issue, spends } = decodeBundle(payload)
      onOutcome(await sendRemote(ctx, { messageId: issueMessageId(ctx.noteDomain, issue.message), issue, spends }))
    },
  }
}
