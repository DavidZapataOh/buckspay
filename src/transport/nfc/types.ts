export type NfcSupport = {
  /** The phone has an NFC controller. */
  hardware: boolean
  /** Host card emulation is available. */
  hce: boolean
  /** NFC is switched on. */
  enabled: boolean
  /** This phone may poll: on Android 15 the user can switch the NFC reader option off. */
  reader: boolean
}

export type NfcErrorCode = 'Cancelled' | 'Interrupted' | 'Malformed' | 'Busy' | 'Unavailable'

export class NfcNativeError extends Error {
  constructor(readonly code: NfcErrorCode) {
    super(code)
    this.name = 'NfcNativeError'
  }
}

export type NfcProgress = {
  opId: number
  direction: 'in' | 'out'
  kind: number
  done: number
  total: number
  /** Milliseconds since the link was established; set by the module, absent in tests. */
  linkMs?: number
}

export type NfcRole = 'card' | 'reader'

/**
 * The native module as JavaScript sees it. At most one role is held at a time (`acquire` rejects with
 * Busy otherwise). Every operation is named by `opId`, so `cancel` ends exactly one of them.
 */
export interface NfcNative {
  support(): Promise<NfcSupport>
  acquire(role: NfcRole): Promise<void>
  release(): Promise<void>
  /** Card: shows the message; resolves when a reader confirmed the whole of it. */
  offer(opId: number, kind: number, payload: Uint8Array): Promise<void>
  /** Reader: pushes the message into the card's inbox; resolves when the card has it. */
  push(opId: number, kind: number, payload: Uint8Array): Promise<void>
  /** Either role: the next whole message whose kind is in `acceptMask` (bit k for kind k). */
  receive(opId: number, acceptMask: number): Promise<{ kind: number; payload: Uint8Array }>
  cancel(opId: number): void
  addProgressListener(listener: (progress: NfcProgress) => void): () => void
}
