import { MessageKind, type Transport } from '../../transport/types'

export type LabRole = 'host' | 'find'

export type TrialResult = {
  role: LabRole
  size: number
  trial: number
  ok: boolean
  /** Milliseconds `send` took: with delivery feedback it resolves once the other phone has the whole message. */
  sendMs: number
  ms: number
  result: string
}

const bytes = (length: number, seed: number) => Uint8Array.from({ length }, (_, i) => (i * 31 + seed) & 0xff)
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i])

/** One round trip: the host sends `bytes(size, trial)` and the finder answers `bytes(size, trial + 1000)`. */
export async function trial(
  transport: Transport,
  role: LabRole,
  size: number,
  index: number,
  timeoutMs = 60_000,
): Promise<TrialResult> {
  const started = Date.now()
  let ok = false
  let result = 'ok'
  let sendMs = 0
  const send = async (kind: MessageKind, payload: Uint8Array) => {
    const at = Date.now()
    await transport.send({ kind, payload })
    sendMs = Date.now() - at
  }
  try {
    if (role === 'host') {
      await send(MessageKind.Request, bytes(size, index))
      const back = await transport.receive({ accept: [MessageKind.Payment], timeoutMs })
      ok = same(back.payload, bytes(size, index + 1000))
    } else {
      const got = await transport.receive({ accept: [MessageKind.Request], timeoutMs })
      ok = same(got.payload, bytes(size, index))
      await send(MessageKind.Payment, bytes(size, index + 1000))
    }
  } catch (error) {
    result = String((error as Error).message)
  }
  return { role, size, trial: index, ok, sendMs, ms: Date.now() - started, result }
}
