import { type Message, type ReceiveOptions, type TransportEvent, TransportError, type TransportState } from './types'
import { waitForMessage } from './wait'

/** What every transport shares: events, the state rules, pending receives and an idempotent close. */
export abstract class TransportBase {
  private readonly listeners = new Set<(event: TransportEvent) => void>()
  private readonly pending = new Set<AbortController>()
  private closed = false
  private shown = false
  private last: TransportState = 'idle'

  get state(): TransportState {
    return this.pending.size > 0 ? 'receiving' : this.shown ? 'sending' : 'idle'
  }

  subscribe(listener: (event: TransportEvent) => void) {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  async close() {
    if (this.closed) return
    this.closed = true
    for (const controller of this.pending) controller.abort()
    this.shown = false
    this.release()
    this.notifyState()
  }

  /** Clears whatever the transport shows or holds; called once, on close. */
  protected abstract release(): void

  protected emit(event: TransportEvent) {
    for (const listener of [...this.listeners]) listener(event)
  }

  protected assertOpen(signal?: AbortSignal) {
    if (this.closed || signal?.aborted) throw new TransportError('Cancelled')
  }

  protected setShown(shown: boolean) {
    this.shown = shown
    this.notifyState()
  }

  protected receiveWith(
    options: ReceiveOptions | undefined,
    start: (deliver: (message: Message) => void) => () => void,
  ): Promise<Message> {
    if (this.closed || options?.signal?.aborted) return Promise.reject(new TransportError('Cancelled'))
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    options?.signal?.addEventListener('abort', onAbort)
    this.pending.add(controller)
    this.notifyState()
    return waitForMessage({ ...options, signal: controller.signal }, start).finally(() => {
      options?.signal?.removeEventListener('abort', onAbort)
      this.pending.delete(controller)
      this.notifyState()
    })
  }

  private notifyState() {
    if (this.state === this.last) return
    this.last = this.state
    this.emit({ type: 'state', state: this.last })
  }
}
