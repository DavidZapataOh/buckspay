import { checkBytes, ProtocolError } from './codec'

/** The precompile verifies at most this many signatures per instruction. */
export const MAX_SIGNATURES = 8
export const KEY_LEN = 33
export const SIGNATURE_LEN = 64
export const MESSAGE_LEN = 96
const OFFSETS_START = 2
const OFFSETS_LEN = 14
const BLOCK_LEN = KEY_LEN + SIGNATURE_LEN + MESSAGE_LEN

/** A key and the 96-byte envelope it must have signed. */
export type Expected = { key: Uint8Array; message: Uint8Array }

/** Length of the instruction data for `count` signatures. */
export const dataLength = (count: number) => OFFSETS_START + count * (OFFSETS_LEN + BLOCK_LEN)

const blockStart = (index: number, count: number) => OFFSETS_START + count * OFFSETS_LEN + index * BLOCK_LEN

/** The offsets of signature `index`, every field inline: the instruction index is `0xffff` throughout. */
function offsets(index: number, count: number): Uint8Array {
  const key = blockStart(index, count)
  const out = new Uint8Array(OFFSETS_LEN)
  const view = new DataView(out.buffer)
  const fields = [key + KEY_LEN, 0xffff, key, 0xffff, key + KEY_LEN + SIGNATURE_LEN, MESSAGE_LEN, 0xffff]
  fields.forEach((field, i) => view.setUint16(2 * i, field, true))
  return out
}

/**
 * The data of one secp256r1 precompile instruction that carries every signature, key and message
 * inline, in the layout the program reads (`[count][0][offsets × count][key ‖ signature ‖ message]
 * × count`). The twin of `secp256r1::write`.
 */
export function writeVerification(entries: Expected[], signatures: Uint8Array[]): Uint8Array {
  const count = entries.length
  if (count === 0 || count > MAX_SIGNATURES || signatures.length !== count) throw new ProtocolError('Length')
  const out = new Uint8Array(dataLength(count))
  out[0] = count
  entries.forEach(({ key, message }, i) => {
    checkBytes(key, KEY_LEN)
    checkBytes(message, MESSAGE_LEN)
    checkBytes(signatures[i], SIGNATURE_LEN)
    out.set(offsets(i, count), OFFSETS_START + i * OFFSETS_LEN)
    const block = blockStart(i, count)
    out.set(key, block)
    out.set(signatures[i], block + KEY_LEN)
    out.set(message, block + KEY_LEN + SIGNATURE_LEN)
  })
  return out
}
