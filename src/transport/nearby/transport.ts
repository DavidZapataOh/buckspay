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
import type { NearbyLink, NearbyNative, NearbySupport } from './types'

const WIRE_VERSION = 1
const KINDS: readonly number[] = Object.values(MessageKind)

/** Messages that may arrive before anyone asks for them: the receipt can beat the payer's `receive`. */
export const QUEUE_LIMIT = 8

export function nearbyAvailability(support: NearbySupport): Availability {
  if (!support.playServices) return { ready: false, reason: 'unsupported' }
  if (!support.permissions) return { ready: false, reason: 'permission-denied' }
  if (!support.bluetooth) return { ready: false, reason: 'disabled' }
  return { ready: true }
}

function decode(wire: Uint8Array): Message | null {
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

  constructor(link: NearbyLink) {
    super()
    this.native = link.native
    this.endpointId = link.endpointId
    this.unlisten = this.native.addListener((event) => {
      if (event.endpointId !== this.endpointId) return
      if (event.type === 'message') this.chain = this.chain.then(() => this.pull())
      else if (event.type === 'disconnected') this.end('Interrupted', false)
    })
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
    try {
      await this.native.sendBytes(this.endpointId, wire)
    } catch {
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
    this.disconnect()
  }

  private async pull() {
    if (this.dead) return
    let wire: Uint8Array | null
    try {
      wire = await this.native.takeMessage(this.endpointId)
    } catch {
      return this.end('Interrupted', true)
    }
    if (!wire || this.dead) return
    const message = decode(wire)
    if (!message) return this.end('Malformed', true)
    const waiter = this.waiter
    if (waiter) {
      if (!waiter.accept || waiter.accept.includes(message.kind)) this.handOver(waiter.deliver, message)
    } else if (this.queue.length >= QUEUE_LIMIT) this.end('Malformed', true)
    else this.queue.push(message)
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
    this.waiter?.fail(new TransportError(code))
    if (hangUp) this.disconnect()
    else this.disconnected = true
  }

  private disconnect() {
    if (this.disconnected) return
    this.disconnected = true
    void this.native.disconnect(this.endpointId).catch(() => {})
  }
}

export const createNearbyTransport = (link: NearbyLink): Transport => new NearbyTransport(link)
