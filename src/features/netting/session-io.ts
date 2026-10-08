import type { GroupWire } from '../../transport/nearby/group'
import { ChannelError, HOST, type SessionChannel } from './channel'
import { decodeMessage, encodeMessage, MessageError, type SessionMessage } from './messages'

export type Inbound = { sender: number; endpoint: string; message: SessionMessage }
export type Taken = Inbound | { gone: string } | 'timeout' | 'aborted'

/** Opens every frame of a wire, drops what the rules say to drop, and hands the valid messages to the session in order. */
export class Inbox {
  readonly #queue: Inbound[] = []
  readonly #gone: string[] = []
  readonly #waiters = new Set<() => void>()
  readonly #identified = new Map<string, number>()
  readonly #off: (() => void)[]
  #opening: Promise<void> = Promise.resolve()

  constructor(
    private readonly wire: GroupWire,
    private readonly channel: SessionChannel,
    private readonly participants: () => number[],
  ) {
    this.#off = [
      wire.onFrame((frame, from) => {
        this.#opening = this.#opening.then(() => this.#receive(frame, from))
      }),
      wire.onLink((event) => {
        if (event.type === 'down') this.#push(() => this.#gone.push(event.endpoint))
      }),
    ]
  }

  async #receive(frame: Uint8Array, endpoint: string): Promise<void> {
    const hub = this.wire.role === 'hub'
    try {
      const opened = await this.channel.open(frame, endpoint)
      if (hub) {
        const known = this.#identified.get(endpoint)
        if (opened.sender !== 0xff) {
          if (known !== undefined && known !== opened.sender) throw new ChannelError('Forged')
          if (known === undefined) {
            this.#identified.set(endpoint, opened.sender)
            this.wire.identify(endpoint, opened.sender)
          }
        }
      } else if (opened.sender !== HOST) {
        return
      }
      const message = this.#decode(opened.type, opened.body)
      this.#push(() => this.#queue.push({ sender: opened.sender, endpoint, message }))
    } catch (error) {
      if (error instanceof ChannelError && error.code === 'Replayed') return
      if (error instanceof ChannelError || error instanceof MessageError) {
        if (hub) await this.wire.drop(endpoint)
        return
      }
      throw error
    }
  }

  #decode(type: number, body: Uint8Array): SessionMessage {
    const candidates = this.participants()
    if (type !== 0x15 || candidates.length === 0) return decodeMessage(type, body, candidates[0])
    for (const n of candidates) {
      if (body.length === 64 * n + 256) return decodeMessage(type, body, n)
    }
    throw new MessageError('final length')
  }

  #push(add: () => void) {
    add()
    this.#waiters.forEach((wake) => wake())
  }

  /** Marks a joining endpoint as a member once the roster gave it an index. */
  adopt(endpoint: string, index: number) {
    this.#identified.set(endpoint, index)
    this.wire.identify(endpoint, index)
  }

  /** The first queued message `accept` takes, or the first link that went down, within `ms`. */
  take(accept: (inbound: Inbound) => boolean, ms: number, signal?: AbortSignal): Promise<Taken> {
    return new Promise((resolve) => {
      const check = (): Taken | null => {
        const at = this.#queue.findIndex(accept)
        if (at >= 0) return this.#queue.splice(at, 1)[0]
        const gone = this.#gone.shift()
        return gone === undefined ? null : { gone }
      }
      const finish = (value: Taken) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.#waiters.delete(wake)
        resolve(value)
      }
      const wake = () => {
        const found = check()
        if (found) finish(found)
      }
      const onAbort = () => finish('aborted')
      const timer = setTimeout(() => finish('timeout'), ms)
      signal?.addEventListener('abort', onAbort)
      this.#waiters.add(wake)
      if (signal?.aborted) return onAbort()
      wake()
    })
  }

  /** Whether a message `accept` takes is already queued. */
  has(accept: (inbound: Inbound) => boolean): boolean {
    return this.#queue.some(accept)
  }

  async settle(): Promise<void> {
    await this.#opening
  }

  close() {
    this.#off.forEach((off) => off())
  }
}

export async function sealMessage(channel: SessionChannel, message: SessionMessage): Promise<Uint8Array> {
  const { type, body } = encodeMessage(message)
  return channel.seal(type, body)
}
