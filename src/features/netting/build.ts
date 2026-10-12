import { type NettingStatement, sessionField } from '../../protocol'
import { fromCanonical, toBytes32 } from '../rewards/secrets-poseidon'
import { digest, rootOf, type Slot, SLOTS, slotIndex } from './digest'

export const PARTICIPANT_SLOTS = 8

/** The tab between participants `i < j` as it enters the statement. */
export type PairSlot = { i: number; j: number; slot: Slot }

export type StatementFields = Omit<NettingStatement, 'root'>

/** The statement with its root, and the eight digests it is made of; a participant with no tab has the digest of an empty row. */
export function buildStatement(
  fields: StatementFields,
  pairs: readonly PairSlot[],
): { statement: NettingStatement; digests: Uint8Array[] } {
  const slots: (Slot | null)[] = Array(SLOTS).fill(null)
  for (const { i, j, slot } of pairs) slots[slotIndex(i, j)] = slot
  const field = sessionField({ ...fields, root: new Uint8Array(32) })
  const values = Array.from({ length: PARTICIPANT_SLOTS }, (_, p) => digest(field, p, slots))
  return {
    statement: { ...fields, root: toBytes32(rootOf(values)) },
    digests: values.map(toBytes32),
  }
}

/** The root the eight digests give, as the statement carries it. */
export const rootBytes = (digests: readonly Uint8Array[]): Uint8Array =>
  toBytes32(rootOf(digests.map((d) => fromCanonical(d, 'digest'))))
