import { type Message, type ReceiveOptions, TransportError } from './types'

export type Deliver = (message: Message) => void
export type Fail = (error: TransportError) => void

/**
 * One promise for a receive: it settles with the first delivered message of an accepted kind, or
 * with `Cancelled` (signal), `Timeout` or the error a source passes to `fail`. `start` returns its
 * cleanup, which runs exactly once.
 */
export function waitForMessage(
  options: ReceiveOptions | undefined,
  start: (deliver: Deliver, fail: Fail) => () => void,
): Promise<Message> {
  return new Promise((resolve, reject) => {
    const { signal, timeoutMs, accept } = options ?? {}
    if (signal?.aborted) return reject(new TransportError('Cancelled'))
    let settled = false
    let stop: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (finish: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      stop?.()
      finish()
    }
    const onAbort = () => settle(() => reject(new TransportError('Cancelled')))
    signal?.addEventListener('abort', onAbort)
    if (timeoutMs !== undefined)
      timer = setTimeout(() => settle(() => reject(new TransportError('Timeout'))), timeoutMs)
    const cleanup = start(
      (message) => {
        if (!accept || accept.includes(message.kind)) settle(() => resolve(message))
      },
      (error) => settle(() => reject(error)),
    )
    if (settled) cleanup()
    else stop = cleanup
  })
}
