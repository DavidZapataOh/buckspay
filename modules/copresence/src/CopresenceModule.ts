import { NativeModule, requireNativeModule } from 'expo'

export type Band = 'ultrasound' | 'audible'

export type CopresenceCheck = {
  ready: boolean
  reason?: 'permission-denied' | 'hardware-missing' | 'disabled' | 'unsupported'
  volumeLow: boolean
  route: 'speaker' | 'headset' | 'bluetooth'
}

export type CopresenceState = { recording: boolean; silenced: boolean; volumeLow: boolean; route: string }

type CopresenceEvents = {
  onMessage(event: { length: number }): void
  onState(event: CopresenceState): void
}

/**
 * A data-over-sound modem: plays one payload at a time and delivers every payload it decodes. It holds no
 * key, records nothing and knows no payment.
 */
declare class CopresenceModule extends NativeModule<CopresenceEvents> {
  check(): Promise<CopresenceCheck>
  /** Asks for the microphone permission; resolves true when it is granted. */
  requestPermission(): Promise<boolean>
  /** Opens the microphone and the decoder for one band. */
  start(band: Band): Promise<void>
  stop(): Promise<void>
  /** The oldest decoded payload, or null; each is announced by `onMessage`. */
  take(): Uint8Array | null
  /** Resolves when the sound has ended. */
  play(opId: number, payload: Uint8Array, band: Band): Promise<void>
  cancel(opId: number): void
}

export default requireNativeModule<CopresenceModule>('Copresence')
