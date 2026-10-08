import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { type CoSignedIou, encodeCoSigned, IouCause } from '../../protocol'
import { formatMoney } from '../../utils/format-amount'
import { equalBytes } from '@noble/curves/utils.js'
import { debtsCopy } from './copy'
import { type AppliedNetting, balance, expectedBalance, type RepayStatus } from './tab'
import type { StateRow, TabRow } from './store'

/** Peers have no names: a friend is shown by six hex digits of the hash of their device key. */
export const peerLabel = (key: Uint8Array): string => `Friend ${bytesToHex(sha256(key)).slice(0, 6)}`

/** The first four bytes of the hash of every co-signed state in `seq` order, as `xxxx xxxx`: two phones agree only when they hold the same changes. */
export function recordCode(states: readonly CoSignedIou[]): string {
  const wires = [...states].sort((a, b) => a.iou.seq - b.iou.seq).map(encodeCoSigned)
  const hex = bytesToHex(sha256(concatBytes(...wires)).slice(0, 4))
  return `${hex.slice(0, 4)} ${hex.slice(4)}`
}

export type TabSummary = {
  tab: Uint8Array
  peerLabel: string
  direction: 'owed' | 'owe' | 'settled'
  amount: bigint
  seq: number
  recordCode: string
  /** A proposal this phone made is waiting for the friend's signature. */
  waiting: boolean
  locked: boolean
  orphaned: boolean
  settling: boolean
  /** How much the debt will go down once the payments still settling are done. */
  settlingAmount: bigint
  /** A repayment or a netting is not decided yet: "clear" is not offered. */
  pending: boolean
}

const undecided = new Set<RepayStatus['status']>(['settling', 'unknown', 'undecided'])

/** What a tab screen or list row shows, from this phone's side (`expectedBalance` counts payments still settling). */
export function summarize(
  me: Uint8Array,
  row: TabRow,
  states: readonly CoSignedIou[],
  pending: StateRow | null,
  nettings: readonly AppliedNetting[],
  repays: readonly RepayStatus[],
): TabSummary {
  const expected = expectedBalance(me, states, nettings, repays)
  const settled = balance(me, states, nettings, repays)
  const latest = states.length > 0 ? [...states].sort((a, b) => a.iou.seq - b.iou.seq).at(-1)!.iou : pending?.iou
  const settlingAmount = expected > settled ? expected - settled : settled - expected
  return {
    tab: row.tab,
    peerLabel: peerLabel(row.peer),
    direction: expected > 0n ? 'owed' : expected < 0n ? 'owe' : 'settled',
    amount: expected < 0n ? -expected : expected,
    seq: row.finalSeq,
    recordCode: recordCode(states),
    waiting: pending !== null,
    locked: row.lockedBy !== null,
    orphaned: latest !== undefined && !equalBytes(latest.debtor, me) && !equalBytes(latest.creditor, me),
    settling: settlingAmount !== 0n,
    settlingAmount,
    pending: row.lockedBy !== null || repays.some((r) => undecided.has(r.status)),
  }
}

export const money = (amount: bigint, decimals: number, symbol: string) => `${formatMoney(amount, decimals)} ${symbol}`

/** The sentence for a balance seen from `me` (+ = the peer owes me). */
export function balanceLine(peer: string, balanceUnits: bigint, decimals: number, symbol: string): string {
  if (balanceUnits === 0n) return debtsCopy.settled(peer)
  const amount = money(balanceUnits < 0n ? -balanceUnits : balanceUnits, decimals, symbol)
  return balanceUnits > 0n ? debtsCopy.owed(peer, amount) : debtsCopy.owe(peer, amount)
}

/** What one change does to `me`: + when the friend owes more, - when the debt goes down. */
export function signedChange(
  me: Uint8Array,
  change: { debtor: Uint8Array; creditor: Uint8Array; amount: bigint; cause: number },
): bigint {
  const toward = equalBytes(change.creditor, me) ? change.amount : -change.amount
  return change.cause === IouCause.Open ? toward : -toward
}

/** A date as a person reads it (UTC, year first: the same on both phones). */
export const formatDate = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10)

const FRIEND_PREFIX = 'buckspay://debts?friend='

/** The code a phone shows to be offered a first debt: its device key, so the friend knows whom to sign with. */
export const friendCode = (key: Uint8Array): string => `${FRIEND_PREFIX}${bytesToHex(key)}`

/** The device key in a friend code, or `undefined` for any other text. */
export function parseFriendCode(text: string): Uint8Array | undefined {
  const match = /^buckspay:\/\/debts\?friend=((?:02|03)[0-9a-f]{64})$/.exec(text.trim())
  return match ? hexToBytes(match[1]) : undefined
}
