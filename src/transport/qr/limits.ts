import type { FrameLimits } from '../framing'
import { base45Capacity } from './base45'

export const TEXT_PREFIX = 'BP:'

/** Characters per QR (alphanumeric mode, level M): version 15 for one frame, version 10 for each of several. */
export const QR_CHARS = { single: 600, multi: 311 } as const

export const qrFrameLimits = (chars: { single: number; multi: number } = QR_CHARS): FrameLimits => ({
  single: base45Capacity(chars.single - TEXT_PREFIX.length),
  multi: base45Capacity(chars.multi - TEXT_PREFIX.length),
})
