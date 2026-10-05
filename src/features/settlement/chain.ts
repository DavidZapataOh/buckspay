import { bytesToHex } from '@noble/hashes/utils.js'
import { encodeIssue, encodeSpend, type Issue, type Signed, type Spend } from '../../protocol'
import type { ReclaimRequest, SettlementRequest } from '../lock/gateway'

/** The issue of a note and the spends that carried it to the output being settled or reclaimed. */
export type NoteChain = { issue: Signed<Issue>; spends: Signed<Spend>[] }

/** The wire formats of the protocol, hex: a signed issue, then each signed spend in chain order. */
export const settlementRequest = ({ issue, spends }: NoteChain): SettlementRequest => ({
  issue: bytesToHex(encodeIssue(issue)),
  spends: spends.map((spend) => bytesToHex(encodeSpend(spend))),
})

/**
 * A reclaim of output `which` of the last message of `chain` by `owner`, with `signature` over the
 * reclaim envelope that holds `deadline` (made with `signReclaim`).
 */
export const reclaimRequest = (
  chain: NoteChain,
  owner: Uint8Array,
  which: 0 | 1,
  deadline: number,
  signature: Uint8Array,
): ReclaimRequest => ({
  ...settlementRequest(chain),
  owner: bytesToHex(owner),
  which,
  deadline,
  signature: bytesToHex(signature),
})
