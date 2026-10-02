import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { checkU32, checkU64, checkU8, ProtocolError } from './codec'

export const Purpose = {
  Note: 'note',
  Ticket: 'ticket',
  Device: 'device',
  Witness: 'witness',
  Reclaim: 'reclaim',
  PayWord: 'payword',
  Iou: 'iou',
  Voice: 'voice',
  Claim: 'claim',
} as const

const DOMAIN_TAG = utf8ToBytes('BUCKSPAY:v1:')
const OUTPUT_TAG = utf8ToBytes('BPO1')
const ISSUE_SLOT_TAG = utf8ToBytes('ISSU')

function check32(...values: Uint8Array[]) {
  if (values.some((value) => value.length !== 32)) throw new ProtocolError('Length')
}

export function domain(
  purpose: (typeof Purpose)[keyof typeof Purpose],
  genesisHash: Uint8Array,
  programId: Uint8Array,
): Uint8Array {
  check32(genesisHash, programId)
  return sha256(concatBytes(DOMAIN_TAG, utf8ToBytes(purpose), genesisHash, programId))
}

export const content = (body: Uint8Array) => sha256(body)

export function envelope(domain: Uint8Array, slot: Uint8Array, content: Uint8Array): Uint8Array {
  check32(domain, slot, content)
  return concatBytes(domain, slot, content)
}

export const messageId = (envelope: Uint8Array) => sha256(envelope)
export function outputId(messageId: Uint8Array, index: number): Uint8Array {
  checkU8(index)
  return sha256(concatBytes(OUTPUT_TAG, messageId, Uint8Array.of(index)))
}

export function issueSlot(lockSeq: number, start: bigint, end: bigint): Uint8Array {
  checkU32(lockSeq)
  checkU64(start)
  checkU64(end)
  const slot = new Uint8Array(32)
  const view = new DataView(slot.buffer)
  slot.set(ISSUE_SLOT_TAG)
  view.setUint32(4, lockSeq, true)
  view.setBigUint64(8, start, true)
  view.setBigUint64(16, end, true)
  return slot
}
