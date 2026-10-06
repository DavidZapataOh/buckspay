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
  type TransportErrorCode,
} from '../types'
import { type NfcNative, NfcNativeError, type NfcProgress, type NfcRole, type NfcSupport } from './types'

const ALL_KINDS = Object.values(MessageKind).reduce<number>((mask, kind) => mask | (1 << kind), 0)
const KINDS: readonly number[] = Object.values(MessageKind)

/** Operation ids are unique across transports, so a progress event or a cancel names exactly one call. */
let lastOperation = 0

export function nfcAvailability(support: NfcSupport, role?: NfcRole): Availability {
  if (!support.hardware) return { ready: false, reason: 'hardware-missing' }
  if (!support.hce) return { ready: false, reason: 'unsupported' }
  if (!support.enabled || (role === 'reader' && !support.reader)) return { ready: false, reason: 'disabled' }
  return { ready: true }
}

function toTransportError(error: unknown): TransportError {
  if (error instanceof TransportError) return error
  return new TransportError(error instanceof NfcNativeError ? (error.code satisfies TransportErrorCode) : 'Unavailable')
}

class NfcTransport extends TransportBase implements Transport {
  readonly id = 'nfc'
  readonly capabilities = { maxMessageBytes: MAX_MESSAGE_BYTES, deliveryFeedback: true } as const

  private role: NfcRole | undefined
  private held: Promise<void> | undefined
  private readonly operations = new Map<number, { kind?: number; length?: number }>()
  private readonly unlisten: () => void

  constructor(
    private readonly native: NfcNative,
    private readonly fixedRole?: NfcRole,
  ) {
    super()
    this.unlisten = native.addProgressListener((event) => this.onProgress(event))
  }

  async check() {
    return nfcAvailability(await this.native.support(), this.role ?? this.fixedRole)
  }

  async send(message: Message, options?: SendOptions) {
    this.assertOpen(options?.signal)
    if (message.payload.length > this.capabilities.maxMessageBytes) throw new TransportError('TooLarge')
    const opId = ++lastOperation
    this.operations.set(opId, { kind: message.kind, length: message.payload.length })
    const abort = () => this.native.cancel(opId)
    options?.signal?.addEventListener('abort', abort)
    this.setShown(true)
    try {
      await this.hold('card')
      if (options?.signal?.aborted) throw new TransportError('Cancelled')
      const move = this.role === 'card' ? this.native.offer : this.native.push
      await move.call(this.native, opId, message.kind, message.payload)
    } catch (error) {
      throw toTransportError(error)
    } finally {
      options?.signal?.removeEventListener('abort', abort)
      this.operations.delete(opId)
      this.setShown(false)
    }
    this.emit({
      type: 'progress',
      direction: 'out',
      kind: message.kind,
      unit: 'bytes',
      done: message.payload.length,
      total: message.payload.length,
    })
  }

  receive(options?: ReceiveOptions) {
    return this.receiveWith(options, (deliver, fail) => {
      const opId = ++lastOperation
      let stopped = false
      const mask = options?.accept?.reduce<number>((bits, kind) => bits | (1 << kind), 0) ?? ALL_KINDS
      this.hold('reader')
        .then(() => (stopped ? undefined : this.native.receive(opId, mask)))
        .then((message) => {
          if (!message) return
          const kind = message.kind as MessageKind
          if (!KINDS.includes(kind)) return fail(new TransportError('Malformed'))
          this.emit({
            type: 'progress',
            direction: 'in',
            kind,
            unit: 'bytes',
            done: message.payload.length,
            total: message.payload.length,
          })
          deliver({ kind, payload: message.payload })
        })
        .catch((error) => fail(toTransportError(error)))
      return () => {
        stopped = true
        this.native.cancel(opId)
      }
    })
  }

  protected release() {
    this.unlisten()
    for (const opId of this.operations.keys()) this.native.cancel(opId)
    void this.native.release().catch(() => {})
  }

  /** The first call decides the role unless the caller fixed it; one role is held until `close()`. */
  private hold(first: NfcRole) {
    if (!this.held) {
      const role = this.fixedRole ?? first
      this.role = role
      this.held = this.native.acquire(role).catch((error) => {
        this.held = undefined
        this.role = undefined
        throw error
      })
    }
    return this.held
  }

  private onProgress(event: NfcProgress) {
    const operation = this.operations.get(event.opId)
    if (!operation || operation.kind === undefined || !operation.length || event.total === 0) return
    this.emit({
      type: 'progress',
      direction: 'out',
      kind: operation.kind as MessageKind,
      unit: 'bytes',
      done: Math.min(operation.length, Math.round((event.done / event.total) * operation.length)),
      total: operation.length,
    })
  }
}

export const createNfcTransport = (native: NfcNative, role?: NfcRole): Transport => new NfcTransport(native, role)
