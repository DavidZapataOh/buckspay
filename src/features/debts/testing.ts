import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  type CoSignedIou,
  decodeIou,
  DEVNET_GENESIS_HASH,
  domain,
  encodeIou,
  type Iou,
  IouCause,
  type IouCauseValue,
  iouEnvelope,
  Purpose,
} from '../../protocol'

/** Software P-256 parties and fixed values for the debts tests; never imported by shipped code. */
export const PROGRAM = new Uint8Array(32).fill(0xb0)
export const IOU_DOMAIN = domain(Purpose.Iou, DEVNET_GENESIS_HASH, PROGRAM)
export const NOTE_DOMAIN = domain(Purpose.Note, DEVNET_GENESIS_HASH, PROGRAM)
export const MINT = new Uint8Array(32).fill(3)
export const TAB = new Uint8Array(32).fill(0x7a)
export const SECRET = new Uint8Array(32).fill(0x5c)
export const ZERO = new Uint8Array(32)

export type Party = { key: Uint8Array; sign(message: Uint8Array): Uint8Array }

export function party(seed: number): Party {
  const secret = new Uint8Array(32).fill(seed)
  return {
    key: p256.getPublicKey(secret, true),
    sign: (message) => p256.sign(message, secret, { prehash: true, lowS: true, format: 'compact' }),
  }
}

export function iouOf(
  seq: number,
  debtor: Uint8Array,
  creditor: Uint8Array,
  amount: bigint,
  extra: Partial<Iou> = {},
): Iou {
  return {
    tab: TAB,
    seq,
    debtor,
    creditor,
    mint: MINT,
    amount,
    due: 0,
    cause: IouCause.Open,
    reference: ZERO,
    memo: ZERO,
    ...extra,
  }
}

export function coSigned(iou: Iou, debtor: Party, creditor: Party, under = IOU_DOMAIN): CoSignedIou {
  const message = iouEnvelope(iou, under)
  return { iou, debtorSig: debtor.sign(message), creditorSig: creditor.sign(message) }
}

/** The content a later change names as its predecessor. */
export const contentOf = (state: CoSignedIou) => sha256(encodeIou(state.iou))

export type Step = {
  seq: number
  debtor: Party
  creditor: Party
  amount: bigint
  cause?: IouCauseValue
  reference?: Uint8Array
}

/** Co-signed changes of one tab in order; each Open/Outside names the state before it (the first names none), a Repay keeps its own reference. */
export function chain(steps: readonly Step[], tab = TAB): CoSignedIou[] {
  const out: CoSignedIou[] = []
  for (const step of steps) {
    const cause = step.cause ?? IouCause.Open
    const predecessor = out.length > 0 ? contentOf(out[out.length - 1]) : ZERO
    const reference = step.reference ?? (cause === IouCause.Repay ? ZERO : predecessor)
    out.push(
      coSigned(
        iouOf(step.seq, step.debtor.key, step.creditor.key, step.amount, { tab, cause, reference }),
        step.debtor,
        step.creditor,
      ),
    )
  }
  return out
}

/** What `signIouBody` returns on a phone whose device key is `who`. */
export const signerFor =
  (who: Party, under = IOU_DOMAIN) =>
  async (body: Uint8Array) =>
    who.sign(iouEnvelope(decodeIou(body), under))
