import { TransportBase } from '../../transport/base'
import {
  type Availability,
  MAX_MESSAGE_BYTES,
  type Message,
  type MessageKind,
  type ReceiveOptions,
  type SendOptions,
  type Transport,
  TransportError,
} from '../../transport/types'

/** Relay header 3 + session type 1 + frame 26, rounded up. */
export const LINK_OVERHEAD = 64

export type LinkPort = {
  readonly me: number
  /** Member: a Relay frame to the host. Host: routed by `relayRoute` to the member or to the host's own links. */
  send(to: number, kind: MessageKind, payload: Uint8Array): Promise<void>
  onRelay(listener: (from: number, kind: MessageKind, payload: Uint8Array) => void): () => void
}

/** A transport between this phone and member `peer`, relayed through the host. */
export class SessionLink extends TransportBase implements Transport {
  readonly id = 'nearby'
  readonly capabilities = { maxMessageBytes: MAX_MESSAGE_BYTES - LINK_OVERHEAD, deliveryFeedback: false }

  constructor(
    private readonly port: LinkPort,
    private readonly peer: number,
  ) {
    super()
  }

  async check(): Promise<Availability> {
    return { ready: true }
  }

  async send(message: Message, options?: SendOptions) {
    this.assertOpen(options?.signal)
    const size = message.payload.length
    if (size > this.capabilities.maxMessageBytes) throw new TransportError('TooLarge')
    this.setShown(true)
    await this.port.send(this.peer, message.kind, message.payload)
    this.emit({ type: 'progress', direction: 'out', kind: message.kind, unit: 'bytes', done: size, total: size })
    this.setShown(false)
  }

  receive(options?: ReceiveOptions) {
    return this.receiveWith(options, (deliver) =>
      this.port.onRelay((from, kind, payload) => {
        if (from !== this.peer || (options?.accept && !options.accept.includes(kind))) return
        this.emit({
          type: 'progress',
          direction: 'in',
          kind,
          unit: 'bytes',
          done: payload.length,
          total: payload.length,
        })
        deliver({ kind, payload: payload.slice() })
      }),
    )
  }

  protected release() {}
}

/**
 * The host's rule: `from` is the index identified for the endpoint the frame arrived on, never the frame's own
 * field; `to` must be another member (or the host). Returns the Relay to forward, or null to drop.
 */
export function relayRoute(
  identified: number,
  relay: { to: number; kind: MessageKind; payload: Uint8Array },
  members: number,
): { from: number; to: number; kind: MessageKind; payload: Uint8Array } | null {
  if (relay.to === identified || relay.to < 0 || relay.to >= members) return null
  return { from: identified, to: relay.to, kind: relay.kind, payload: relay.payload }
}
