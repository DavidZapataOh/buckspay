import { equalBytes } from '@noble/curves/utils.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { sanitizeMemo } from '../../payment/messages'
import { frameToText, textToFrame } from '../../transport/qr/text'
import { BUILD_MINT_BYTES } from '../pay/tokens'

/** Who a pay link pays: a wallet, the token it takes and a name its owner chose. No amount and no device key. */
export type PayLink = { wallet: Uint8Array; mint: Uint8Array; name: string }

const VERSION = 1
const MAX_NAME_BYTES = 32
const HEADER = 1 + 32 + 32 + 1
const encoder = new TextEncoder()

/** `BP:` text of `version 1 ‖ wallet 32 ‖ mint 32 ‖ nameLen u8 ‖ name`; throws for a name longer than 32 bytes. */
export function encodePayLink({ wallet, mint, name }: PayLink): string {
  const bytes = encoder.encode(sanitizeMemo(name))
  if (bytes.length > MAX_NAME_BYTES || wallet.length !== 32 || mint.length !== 32) throw new Error('Not a pay link.')
  return frameToText(concatBytes(Uint8Array.of(VERSION), wallet, mint, Uint8Array.of(bytes.length), bytes))
}

/** Throws for another version, a wrong size, a name that is not clean text, or a mint that is not this build's. */
export function decodePayLink(text: string): PayLink {
  let frame: Uint8Array | null
  try {
    frame = textToFrame(text.trim())
  } catch {
    frame = null
  }
  if (!frame || frame.length < HEADER || frame[0] !== VERSION) throw new Error('Not a pay link.')
  const length = frame[HEADER - 1]
  if (length > MAX_NAME_BYTES || frame.length !== HEADER + length) throw new Error('Not a pay link.')
  const mint = frame.slice(33, 65)
  if (!equalBytes(mint, BUILD_MINT_BYTES)) throw new Error('This link is for another token.')
  const name = new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(HEADER))
  if (name !== sanitizeMemo(name)) throw new Error('Not a pay link.')
  return { wallet: frame.slice(1, 33), mint, name }
}
