import { equalBytes } from '@noble/curves/utils.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import {
  checkSpendStep,
  decodeSpend,
  encodeSpend,
  encodeSpendBody,
  forHolder,
  GRACE,
  NO_LOCK,
  type Output,
  ProtocolError,
  type Signed,
  type Spend,
  walkChain,
} from '../../protocol'
import { withRecordableOutputs } from '../../keys/salt'
import { decodeBundle } from '../../payment/messages'
import type { SettlementGateway } from '../lock/gateway'
import {
  expireUnsettled,
  markSettlementSigned,
  prepareSettlement,
  recordConflict,
  setNoteState,
  settleable,
} from '../notes/ledger'
import type { NoteDb } from '../notes/db'
import { settlementRequest } from './chain'
import { settle } from './settle'

/** Seconds before the window closes at which a settlement is no longer started: it could not land. */
export const SETTLEMENT_MARGIN = 120

const SCHEDULE = [30, 120, 600, 3600]

/** The wait after the `attempt`th failure of one note, with a spread of 20% either way. */
export const settlementDelay = (attempt: number, random: () => number) =>
  Math.round(SCHEDULE[Math.min(attempt, SCHEDULE.length - 1)] * (0.8 + 0.4 * random()))

export type SettlementDeps = {
  db: NoteDb
  /** The wallet the device is registered to: the account the notes are settled to. */
  wallet: Uint8Array
  me: Uint8Array
  noteDomain: Uint8Array
  program: Uint8Array
  /** `signSpend` of `src/keys`: checks the hop, asks the native guard, converts to low-S and verifies. */
  signSpend: (input: Output, spend: Spend) => Promise<Signed<Spend>>
  gateway: SettlementGateway
  now: () => number
  salt: () => Uint8Array
  /** Whether the person has read what settling in clear publishes. */
  labelAcknowledged: () => Promise<boolean>
  random: () => number
  /** Failures so far per note (hex of its output id); the runner keeps it between runs. */
  attempts: Map<string, number>
}

export type Refused = { outputId: Uint8Array; kind: string; selfPay: boolean; retryAt?: number }

export type SettlementReport = {
  settled: number
  waiting: number
  failed: number
  blocked?: 'label'
  refused: Refused[]
  /** Seconds until the next run is worth making, when something waits. */
  retryIn?: number
}

const bodyOf = (input: Uint8Array, body: Uint8Array) =>
  decodeSpend(concatBytes(input, body, new Uint8Array(64))).message

/** The spend that settles `output` to `wallet`: one output, an account, no lock. */
function settlementSpend(output: Output, me: Uint8Array, wallet: Uint8Array, salt: () => Uint8Array): Spend {
  const rules = forHolder(output.caveats, { type: 'device', key: me })
  return {
    input: output.id,
    lockSeq: NO_LOCK,
    salt: salt(),
    outputs: {
      type: 'one',
      owner: { type: 'account', address: wallet },
      caveats: { ...rules, hopsLeft: output.caveats.hopsLeft - 1 },
    },
  }
}

/**
 * Settles every note this phone holds, to its own wallet, with no wallet prompt. The body of a note's
 * settlement spend is stored before it is signed and the signed bytes before they are sent, so every
 * retry sends the same content: the guard keeps the first content signed for an output for good.
 */
export async function settleHeld(deps: SettlementDeps): Promise<SettlementReport> {
  const { db } = deps
  const window = GRACE - SETTLEMENT_MARGIN
  const report: SettlementReport = { settled: 0, waiting: 0, failed: 0, refused: [] }
  await expireUnsettled(db, deps.now(), window)
  const notes = await settleable(db, deps.now(), window)
  if (notes.length > 0 && !(await deps.labelAcknowledged())) {
    return { ...report, waiting: notes.length, blocked: 'label' }
  }
  const delays: number[] = []
  for (const note of notes) {
    const key = bytesToHex(note.outputId)
    const wait = (seconds?: number) => {
      const failures = deps.attempts.get(key) ?? 0
      report.waiting++
      delays.push(seconds ?? settlementDelay(failures, deps.random))
      deps.attempts.set(key, failures + 1)
    }
    let wire = note.settlementSpend
    const bundle = decodeBundle(note.bundle)
    const output = walkChain(deps.noteDomain, bundle.issue, bundle.spends).last.find((o) =>
      equalBytes(o.id, note.outputId),
    )
    if (!output) throw new Error('The stored chain does not end in the note')
    if (!wire) {
      let body = note.settlementBody
      if (!body) {
        try {
          const spend = withRecordableOutputs(
            settlementSpend(output, deps.me, deps.wallet, deps.salt),
            (salt) => ({ ...settlementSpend(output, deps.me, deps.wallet, () => salt) }),
            (candidate) => checkSpendStep(deps.noteDomain, deps.program, output, candidate, deps.now()),
            deps.salt,
          )
          body = encodeSpendBody(spend)
        } catch (error) {
          if (!(error instanceof ProtocolError)) throw error
          report.failed++
          continue
        }
        await prepareSettlement(db, note.outputId, body, deps.now())
      }
      let signed: Signed<Spend>
      try {
        signed = await deps.signSpend(output, bodyOf(output.id, body))
      } catch {
        wait()
        continue
      }
      if (!equalBytes(encodeSpendBody(signed.message), body)) {
        report.failed++
        continue
      }
      wire = encodeSpend(signed)
      await markSettlementSigned(db, note.outputId, wire, deps.now())
    }
    const outcome = await settle(
      deps.gateway,
      settlementRequest({ issue: bundle.issue, spends: [...bundle.spends, decodeSpend(wire)] }),
    )
    if (outcome.kind === 'sent' || outcome.kind === 'settled') {
      await setNoteState(db, note.outputId, 'settled', deps.now())
      deps.attempts.delete(key)
      report.settled++
    } else if (outcome.kind === 'unknown') {
      wait()
    } else {
      const { refusal } = outcome
      if (refusal.kind === 'conflict') {
        await recordConflict(db, note.outputId, wire, hexToBytes(refusal.recorded), deps.now())
        report.failed++
      } else if (['window', 'closed', 'deadline', 'lock_ended'].includes(refusal.kind)) {
        await setNoteState(db, note.outputId, 'expired', deps.now())
        report.failed++
      } else {
        const retryAt = refusal.kind === 'horizon' ? refusal.retryAt : undefined
        report.refused.push({
          outputId: note.outputId,
          kind: refusal.kind,
          selfPay: outcome.selfPay,
          ...(retryAt === undefined ? {} : { retryAt }),
        })
        const hint =
          retryAt === undefined
            ? 'retryAfter' in refusal && refusal.retryAfter !== undefined
              ? refusal.retryAfter
              : undefined
            : Math.max(0, retryAt - deps.now())
        wait(hint)
      }
    }
  }
  if (delays.length > 0) report.retryIn = Math.min(...delays)
  return report
}
