import { equalBytes } from '@noble/curves/utils.js'
import { TransportBase } from '../base'
import {
  type Availability,
  MAX_MESSAGE_BYTES,
  type Message,
  MessageKind,
  type ReceiveOptions,
  type SendOptions,
  type Transport,
  TransportError,
} from '../types'
import type { Deliver, Fail } from '../wait'
import type { NearbyLink, NearbyNative, NearbyRole, NearbySupport } from './types'

const WIRE_VERSION = 1

/** Link-layer control, outside the message kinds: the payer's "my side of the link is up". */
const READY = 0xf0
const READY_WIRE = Uint8Array.of(WIRE_VERSION, READY)
const KINDS: readonly number[] = Object.values(MessageKind)

/** Messages that may arrive before anyone asks for them: the receipt can beat the payer's `receive`. */
export const QUEUE_LIMIT = 8

/** How long a phone waits for the other one's request or payment over Nearby before it says so. */
export const NEARBY_WAIT_MS = 30_000

/** How long the payer waits for the receiver's confirmation after it sent the payment over Nearby. */
export const RECEIPT_WAIT_MS = 60_000

/** How often the link layer repeats what the other phone may have missed while it was still connecting. */
export const LINK_RETRY_MS = 3_000

export function nearbyAvailability(support: NearbySupport): Availability {
  if (!support.playServices) return { ready: false, reason: 'unsupported' }
  if (!support.permissions) return { ready: false, reason: 'permission-denied' }
  if (!support.bluetooth) return { ready: false, reason: 'disabled' }
  return { ready: true }
}

function decode(wire: Uint8Array): Message | 'ready' | null {
  if (wire.length === 2 && wire[0] === WIRE_VERSION && wire[1] === READY) return 'ready'
  if (wire.length < 2 || wire[0] !== WIRE_VERSION || !KINDS.includes(wire[1])) return null
  return { kind: wire[1] as MessageKind, payload: wire.slice(2) }
}

type Waiter = { accept?: readonly MessageKind[]; deliver: Deliver; fail: Fail }

class NearbyTransport extends TransportBase implements Transport {
  readonly id = 'nearby'
  readonly capabilities = { maxMessageBytes: MAX_MESSAGE_BYTES, deliveryFeedback: true } as const

  private readonly native: NearbyNative
  private readonly endpointId: string
  private readonly unlisten: () => void
  private queue: Message[] = []
  private waiter: Waiter | null = null
  private sending = false
  private dead = false
  private disconnected = false
  private chain: Promise<void> = Promise.resolve()
  private readonly role: NearbyRole
  private peerReady = false
  private readyWaiters: { resolve: () => void; reject: (error: TransportError) => void }[] = []
  private retry: ReturnType<typeof setInterval> | undefined
  private lastRequest: Uint8Array | undefined

  constructor(link: NearbyLink) {
    super()
    this.native = link.native
    this.endpointId = link.endpointId
    this.role = link.role
    this.unlisten = this.native.addListener((event) => {
      if (event.endpointId !== this.endpointId) return
      if (event.type === 'message') this.chain = this.chain.then(() => this.pull().then(() => {}))
      else if (event.type === 'disconnected') this.end('Interrupted', false)
    })
    this.chain = this.chain.then(() => this.drain())
    if (this.role === 'payer') this.repeat(() => this.raw(READY_WIRE), true)
  }

  async check() {
    return nearbyAvailability(await this.native.support())
  }

  async send(message: Message, options?: SendOptions) {
    this.assertOpen(options?.signal)
    if (this.dead) throw new TransportError('Unavailable', 'disconnected')
    if (this.sending) throw new TransportError('Busy')
    if (message.payload.length > this.capabilities.maxMessageBytes) throw new TransportError('TooLarge')
    const wire = new Uint8Array(message.payload.length + 2)
    wire.set([WIRE_VERSION, message.kind])
    wire.set(message.payload, 2)
    const progress = (done: number) =>
      this.emit({
        type: 'progress',
        direction: 'out',
        kind: message.kind,
        unit: 'bytes',
        done,
        total: message.payload.length,
      })
    this.sending = true
    this.setShown(true)
    progress(0)
    this.stopRepeating()
    try {
      if (this.role === 'receiver' && message.kind === MessageKind.Request) await this.untilReady(options?.signal)
      await this.native.sendBytes(this.endpointId, wire)
      if (this.role === 'receiver' && message.kind === MessageKind.Request) this.repeat(() => this.raw(wire), false)
    } catch (error) {
      if (error instanceof TransportError) throw error
      throw new TransportError('Interrupted')
    } finally {
      this.sending = false
      this.setShown(false)
    }
    progress(message.payload.length)
  }

  receive(options?: ReceiveOptions) {
    if (this.dead && !this.isClosed) return Promise.reject(new TransportError('Unavailable', 'disconnected'))
    if (this.waiter) return Promise.reject(new TransportError('Busy'))
    return this.receiveWith(options, (deliver, fail) => {
      const accept = options?.accept
      const wanted = (message: Message) => !accept || accept.includes(message.kind)
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        if (wanted(next)) {
          this.handOver(deliver, next)
          return () => {}
        }
      }
      const waiter: Waiter = { accept, deliver, fail }
      this.waiter = waiter
      return () => {
        if (this.waiter === waiter) this.waiter = null
      }
    })
  }

  protected release() {
    this.unlisten()
    this.queue = []
    this.dead = true
    this.stopRepeating()
    this.failReadyWaiters(new TransportError('Cancelled'))
    this.disconnect()
  }

  /** Payloads that arrived while the pairing handed the link over were announced to nobody. */
  private async drain() {
    while (await this.pull()) continue
  }

  private async pull(): Promise<boolean> {
    if (this.dead) return false
    let wire: Uint8Array | null
    try {
      wire = await this.native.takeMessage(this.endpointId)
    } catch {
      this.end('Interrupted', true)
      return false
    }
    if (!wire || this.dead) return false
    const message = decode(wire)
    if (!message) {
      this.end('Malformed', true)
      return false
    }
    if (message === 'ready') {
      if (this.role === 'receiver' && !this.peerReady) {
        this.peerReady = true
        for (const { resolve } of this.readyWaiters.splice(0)) resolve()
      }
      return true
    }
    this.stopRepeating()
    if (this.role === 'payer' && message.kind === MessageKind.Request) {
      if (this.lastRequest && equalBytes(this.lastRequest, wire)) return true
      this.lastRequest = wire
    }
    const waiter = this.waiter
    if (waiter) {
      if (!waiter.accept || waiter.accept.includes(message.kind)) this.handOver(waiter.deliver, message)
    } else if (this.queue.length >= QUEUE_LIMIT) this.end('Malformed', true)
    else this.queue.push(message)
    return !this.dead
  }

  private handOver(deliver: Deliver, message: Message) {
    this.emit({
      type: 'progress',
      direction: 'in',
      kind: message.kind,
      unit: 'bytes',
      done: message.payload.length,
      total: message.payload.length,
    })
    deliver(message)
  }

  /** The link is over: what is pending fails with `code`, and every later call is `Unavailable`. */
  private end(code: 'Interrupted' | 'Malformed', hangUp: boolean) {
    if (this.dead) return
    this.dead = true
    this.queue = []
    this.stopRepeating()
    this.failReadyWaiters(new TransportError(code))
    this.waiter?.fail(new TransportError(code))
    if (hangUp) this.disconnect()
    else this.disconnected = true
  }

  private raw(wire: Uint8Array) {
    if (!this.dead) void this.native.sendBytes(this.endpointId, wire).catch(() => {})
  }

  /** Runs `action` now (when asked to) and every `LINK_RETRY_MS` until the other phone is heard or the wait budget is spent. */
  private repeat(action: () => void, now: boolean) {
    this.stopRepeating()
    let left = NEARBY_WAIT_MS / LINK_RETRY_MS
    if (now) action()
    this.retry = setInterval(() => {
      if (left-- <= 0 || this.dead) this.stopRepeating()
      else action()
    }, LINK_RETRY_MS)
  }

  private stopRepeating() {
    clearInterval(this.retry)
    this.retry = undefined
  }

  private untilReady(signal?: AbortSignal) {
    if (this.peerReady) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => settle(() => reject(new TransportError('Timeout'))), NEARBY_WAIT_MS)
      const onAbort = () => settle(() => reject(new TransportError('Cancelled')))
      const waiter = {
        resolve: () => settle(resolve),
        reject: (error: TransportError) => settle(() => reject(error)),
      }
      const settle = (finish: () => void) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.readyWaiters = this.readyWaiters.filter((entry) => entry !== waiter)
        finish()
      }
      signal?.addEventListener('abort', onAbort)
      this.readyWaiters.push(waiter)
    })
  }

  private failReadyWaiters(error: TransportError) {
    for (const { reject } of this.readyWaiters.splice(0)) reject(error)
  }

  private disconnect() {
    if (this.disconnected) return
    this.disconnected = true
    void this.native.disconnect(this.endpointId).catch(() => {})
  }
}

export const createNearbyTransport = (link: NearbyLink): Transport => new NearbyTransport(link)
