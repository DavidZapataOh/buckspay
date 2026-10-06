import { NativeModule, requireNativeModule } from 'expo'

import type { NfcRole, NfcSupport } from '../../../src/transport/nfc/types'

export type NfcProgressEvent = {
  opId: number
  direction: 'in' | 'out'
  /** -1 when the kind is not known yet (a reader sees it only once the message is whole). */
  kind: number
  done: number
  total: number
  linkMs: number | null
}

export type NfcLinkStats = { commands: number; rttMsP50: number; rttMsP95: number; rttMsMax: number; result: string }

type NfcEvents = { onProgress(event: NfcProgressEvent): void }

/**
 * Host card emulation and reader mode with the protocol kept native. `instance` 0 is the radio; 1 and 2 are two
 * phones joined in memory. Rejections carry one of the codes of `NfcErrorCode`.
 */
declare class NfcModule extends NativeModule<NfcEvents> {
  support(instance: number): Promise<NfcSupport>
  acquire(role: NfcRole, instance: number): Promise<void>
  release(instance: number): Promise<void>
  offer(opId: number, kind: number, payload: Uint8Array, instance: number): Promise<void>
  push(opId: number, kind: number, payload: Uint8Array, instance: number): Promise<void>
  receive(opId: number, acceptMask: number, instance: number): Promise<{ kind: number; payload: Uint8Array }>
  cancel(opId: number, instance: number): void
  stats(): NfcLinkStats[]
}

export default requireNativeModule<NfcModule>('Nfc')
