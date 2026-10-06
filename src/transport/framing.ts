import { sha256 } from '@noble/hashes/sha2.js'
import { type Message, MAX_MESSAGE_BYTES, type MessageKind, TransportError } from './types'

export const FRAME_VERSION = 1
export const MAX_FRAMES = 64
export const MULTI_HEADER_BYTES = 7
const ID_BYTES = 4

/** The most bytes one frame may hold, header included. */
export type FrameLimits = { single: number; multi: number }

const sessionId = (payload: Uint8Array) => sha256(payload).slice(0, ID_BYTES)
const header = (kind: number, multi: boolean) => (FRAME_VERSION << 4) | (kind << 1) | (multi ? 1 : 0)

/**
 * A message that fits `limits.single` is one frame; a longer one is equal-sized numbered frames that
 * share an id taken from the payload.
 * @throws TransportError `TooLarge` above MAX_MESSAGE_BYTES or MAX_FRAMES frames, `Malformed` for a kind outside 0..7.
 */
export function encodeFrames({ kind, payload }: Message, limits: FrameLimits): Uint8Array[] {
  if (!Number.isInteger(kind) || kind < 0 || kind > 7) throw new TransportError('Malformed', `kind ${kind}`)
  if (payload.length > MAX_MESSAGE_BYTES) throw new TransportError('TooLarge', `${payload.length} bytes`)
  if (1 + payload.length <= limits.single) return [Uint8Array.of(header(kind, false), ...payload)]
  const total = Math.ceil(payload.length / (limits.multi - MULTI_HEADER_BYTES))
  if (total > MAX_FRAMES) throw new TransportError('TooLarge', `${total} frames`)
  const id = sessionId(payload)
  const size = Math.ceil(payload.length / total)
  return Array.from({ length: total }, (_, index) => {
    const chunk = payload.subarray(index * size, (index + 1) * size)
    const frame = new Uint8Array(MULTI_HEADER_BYTES + chunk.length)
    frame[0] = header(kind, true)
    frame.set(id, 1)
    frame[5] = total
    frame[6] = index
    frame.set(chunk, MULTI_HEADER_BYTES)
    return frame
  })
}

export type Reassembly =
  | { status: 'ignored' }
  | { status: 'progress'; kind: MessageKind; received: number; total: number; duplicate: boolean; restarted: boolean }
  | { status: 'complete'; message: Message }
  | { status: 'corrupt' }

type Session = {
  kind: MessageKind
  id: Uint8Array
  total: number
  chunks: (Uint8Array | undefined)[]
  received: number
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i])

/** Rebuilds messages from frames received in any order, with repeats and frames of other messages. */
export class Reassembler {
  private session: Session | undefined

  push(frame: Uint8Array): Reassembly {
    if (frame.length === 0 || frame[0] >> 4 !== FRAME_VERSION) return { status: 'ignored' }
    const kind = ((frame[0] >> 1) & 7) as MessageKind
    if ((frame[0] & 1) === 0) {
      return frame.length - 1 > MAX_MESSAGE_BYTES
        ? { status: 'ignored' }
        : { status: 'complete', message: { kind, payload: frame.slice(1) } }
    }
    if (frame.length <= MULTI_HEADER_BYTES) return { status: 'ignored' }
    const id = frame.slice(1, 1 + ID_BYTES)
    const total = frame[5]
    const index = frame[6]
    if (total < 2 || total > MAX_FRAMES || index >= total) return { status: 'ignored' }

    let restarted = false
    let session = this.session
    if (!session || session.kind !== kind || session.total !== total || !sameBytes(session.id, id)) {
      restarted = session !== undefined
      session = this.session = { kind, id, total, chunks: new Array(total), received: 0 }
    }
    const duplicate = session.chunks[index] !== undefined
    if (!duplicate) {
      session.chunks[index] = frame.slice(MULTI_HEADER_BYTES)
      session.received++
    }
    if (session.received < total) {
      return { status: 'progress', kind, received: session.received, total, duplicate, restarted }
    }

    this.session = undefined
    const payload = new Uint8Array(session.chunks.reduce((sum, chunk) => sum + chunk!.length, 0))
    if (payload.length > MAX_MESSAGE_BYTES) return { status: 'corrupt' }
    let offset = 0
    for (const chunk of session.chunks) {
      payload.set(chunk!, offset)
      offset += chunk!.length
    }
    return sameBytes(sessionId(payload), id)
      ? { status: 'complete', message: { kind, payload } }
      : { status: 'corrupt' }
  }

  reset() {
    this.session = undefined
  }
}
