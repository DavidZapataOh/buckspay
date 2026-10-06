import { TransportBase } from '../base'
import {
  type Availability,
  MAX_MESSAGE_BYTES,
  type Message,
  type ReceiveOptions,
  type SendOptions,
  type Transport,
  TransportError,
} from '../types'

type Inbox = Set<(message: Message) => void>

class Loopback extends TransportBase implements Transport {
  readonly id = 'qr'
  readonly capabilities = { maxMessageBytes: MAX_MESSAGE_BYTES, deliveryFeedback: false }

  constructor(
    private readonly inbox: Inbox,
    private readonly peer: Inbox,
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
    for (const deliver of [...this.peer]) deliver({ kind: message.kind, payload: message.payload.slice() })
    this.emit({ type: 'progress', direction: 'out', kind: message.kind, unit: 'bytes', done: size, total: size })
  }

  receive(options?: ReceiveOptions) {
    return this.receiveWith(options, (deliver) => {
      const listener = (message: Message) => {
        const size = message.payload.length
        this.emit({ type: 'progress', direction: 'in', kind: message.kind, unit: 'bytes', done: size, total: size })
        deliver(message)
      }
      this.inbox.add(listener)
      return () => void this.inbox.delete(listener)
    })
  }

  protected release() {}
}

/** Two transports that hand whole messages to each other in memory. Tests only. */
export function createLoopbackPair(): [Transport, Transport] {
  const [a, b]: [Inbox, Inbox] = [new Set(), new Set()]
  return [new Loopback(a, b), new Loopback(b, a)]
}
