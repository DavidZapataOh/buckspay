import { type NfcNative, NfcNativeError, type NfcProgress, type NfcRole, type NfcSupport } from '../types'

type Op = { resolve: (value?: never) => void; reject: (error: Error) => void }
type Shown = { kind: number; payload: Uint8Array; opId: number; done: () => void; consumed: boolean }

/** Two phones held together, with the card/reader semantics of the Kotlin protocol. Test double, never shipped. */
export class FakeNfc implements NfcNative {
  peer!: FakeNfc
  role: NfcRole | undefined
  support_: NfcSupport = { hardware: true, hce: true, enabled: true, reader: true }
  private shown: Shown | null = null
  private inbox: { opId: number; mask: number; resolve: (m: { kind: number; payload: Uint8Array }) => void } | null =
    null
  private ops = new Map<number, Op>()
  private progress = new Set<(p: NfcProgress) => void>()
  readonly seen: Uint8Array[] = []
  failNextReceive: NfcNativeError | null = null

  static pair(): [FakeNfc, FakeNfc] {
    const a = new FakeNfc()
    const b = new FakeNfc()
    a.peer = b
    b.peer = a
    return [a, b]
  }

  async support() {
    return this.support_
  }
  async acquire(role: NfcRole) {
    if (this.role) throw new NfcNativeError('Busy')
    this.role = role
  }
  async release() {
    this.role = undefined
    this.shown = null
    this.inbox = null
    for (const [id] of this.ops) this.cancel(id)
  }
  addProgressListener(listener: (p: NfcProgress) => void) {
    this.progress.add(listener)
    return () => void this.progress.delete(listener)
  }
  private emit(p: NfcProgress) {
    this.progress.forEach((l) => l(p))
  }
  private track<T>(opId: number, executor: (resolve: (v: T) => void, reject: (e: Error) => void) => void) {
    return new Promise<T>((resolve, reject) => {
      this.ops.set(opId, { resolve: resolve as never, reject })
      executor(
        (v) => {
          this.ops.delete(opId)
          resolve(v)
        },
        (e) => {
          this.ops.delete(opId)
          reject(e)
        },
      )
    })
  }
  cancel(opId: number) {
    const op = this.ops.get(opId)
    this.ops.delete(opId)
    if (this.shown?.opId === opId) this.shown = null
    if (this.inbox?.opId === opId) this.inbox = null
    op?.reject(new NfcNativeError('Cancelled'))
  }

  offer(opId: number, kind: number, payload: Uint8Array) {
    const old = this.shown
    if (old) this.cancel(old.opId)
    return this.track<void>(opId, (resolve) => {
      this.shown = { kind, payload: payload.slice(), opId, done: () => resolve(), consumed: false }
    })
  }

  push(opId: number, kind: number, payload: Uint8Array) {
    return this.track<void>(opId, (resolve) => {
      const attempt = () => {
        if (!this.ops.has(opId)) return
        const card = this.peer
        if (card.role !== 'card' || !card.inbox) return void setTimeout(attempt, 2)
        const { mask, resolve: deliver, opId: peerOp } = card.inbox
        this.emit({ opId, direction: 'out', kind, done: payload.length, total: payload.length })
        if ((mask >> kind) & 1) {
          card.inbox = null
          card.ops.delete(peerOp)
          deliver({ kind, payload: payload.slice() })
        }
        resolve()
      }
      attempt()
    })
  }

  receive(opId: number, mask: number) {
    if (this.failNextReceive) {
      const error = this.failNextReceive
      this.failNextReceive = null
      return Promise.reject(error)
    }
    return this.track<{ kind: number; payload: Uint8Array }>(opId, (resolve) => {
      if (this.role === 'card') {
        this.inbox = { opId, mask, resolve }
        return
      }
      const poll = () => {
        if (!this.ops.has(opId)) return
        const shown = this.peer.shown
        if (!shown || shown.consumed) return void setTimeout(poll, 2)
        shown.consumed = true
        this.emit({ opId, direction: 'in', kind: shown.kind, done: shown.payload.length, total: shown.payload.length })
        shown.done()
        if ((mask >> shown.kind) & 1) return resolve({ kind: shown.kind, payload: shown.payload.slice() })
        poll()
      }
      poll()
    })
  }
}
