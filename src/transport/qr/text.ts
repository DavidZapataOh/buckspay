import { base45Decode, base45Encode } from './base45'
import { TEXT_PREFIX } from './limits'

export const frameToText = (frame: Uint8Array) => TEXT_PREFIX + base45Encode(frame)

export function textToFrame(text: string): Uint8Array | null {
  return text.startsWith(TEXT_PREFIX) ? base45Decode(text.slice(TEXT_PREFIX.length)) : null
}
