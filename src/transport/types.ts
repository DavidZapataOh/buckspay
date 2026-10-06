export const MessageKind = {
  Request: 0,
  Payment: 1,
  Receipt: 2,
  EventInvite: 3,
  PointPairing: 4,
  EventSync: 5,
} as const
// A value and its type share the name, as an enum does.
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type MessageKind = (typeof MessageKind)[keyof typeof MessageKind]

/** A protocol message as bytes: the transport never looks inside `payload`. */
export type Message = { kind: MessageKind; payload: Uint8Array }

export const MAX_MESSAGE_BYTES = 8192

export type TransportId = 'qr' | 'nfc' | 'nearby'

export type TransportCapabilities = {
  /** The largest `payload` `send` accepts; larger ones fail with `TooLarge` before anything happens. */
  maxMessageBytes: number
  /** Whether `send` resolves only once the peer has the whole message (false when the medium has no back channel). */
  deliveryFeedback: boolean
}

export type Availability =
  { ready: true } | { ready: false; reason: 'permission-denied' | 'hardware-missing' | 'disabled' | 'unsupported' }

export type TransportErrorCode =
  'Cancelled' | 'Timeout' | 'Unavailable' | 'Interrupted' | 'Malformed' | 'TooLarge' | 'Busy'

export class TransportError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'TransportError'
  }
}

/** Whether trying the same turn again can succeed without the user changing anything. */
export const isRetryable = (error: unknown): boolean =>
  error instanceof TransportError && (error.code === 'Timeout' || error.code === 'Interrupted' || error.code === 'Busy')

export type TransportState = 'idle' | 'sending' | 'receiving'

export type TransferProgress = {
  direction: 'in' | 'out'
  kind: MessageKind
  unit: 'frames' | 'bytes'
  done: number
  total: number
}

export type TransportEvent = ({ type: 'progress' } & TransferProgress) | { type: 'state'; state: TransportState }

export type SendOptions = { signal?: AbortSignal }

export type ReceiveOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  /** Kinds to deliver; any other message is dropped silently. Defaults to every kind. */
  accept?: readonly MessageKind[]
}

export interface Transport {
  readonly id: TransportId
  readonly capabilities: TransportCapabilities
  readonly state: TransportState
  check(): Promise<Availability>
  send(message: Message, options?: SendOptions): Promise<void>
  receive(options?: ReceiveOptions): Promise<Message>
  subscribe(listener: (event: TransportEvent) => void): () => void
  close(): Promise<void>
}
