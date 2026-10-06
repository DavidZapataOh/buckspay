import { expand, extract } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { type GatewayConfig, type PinnedKey, PINNED_GATEWAY_KEYS, pinnedKey, sealWithExport } from '../../protocol/hpke'
import { open } from './aead'

export const RELAY_AAD = new TextEncoder().encode('buckspay/relay/v1')
export const EXPORT_LABEL = new TextEncoder().encode('buckspay relay response')
export const RESPONSE_PAD = 256

export type RelayAnswer =
  | { status: 'submitted' | 'duplicate' }
  | { status: 'settled'; signature: string }
  | { status: 'retry'; retryAfter: number }
  | { status: 'refused'; reason: 'invalid' | 'window' | 'conflict' | 'lock' }

/** A settlement sealed to the gateway: what is posted, and what reads the answer only this payer can. */
export type SealedRelay = {
  /** `keyId u8 ‖ enc 32 ‖ ciphertext`. */
  blob: Uint8Array
  /** The first four bytes of the genesis hash: the beacons of this cluster only take it. */
  clusterTag: Uint8Array
  /** The HPKE exporter secret the answer is sealed under. */
  secret: Uint8Array
  openResponse(response: Uint8Array): Promise<RelayAnswer | null>
}

const text = new TextEncoder()

/** The JSON of an answer sealed under `secret` and `enc` (RFC 9458 section 4.4), or `null` if it does not open. */
export async function openResponseWith(
  secret: Uint8Array,
  enc: Uint8Array,
  sealed: Uint8Array,
): Promise<Record<string, unknown> | null> {
  if (sealed.length < 32 + 16) return null
  const nonce = sealed.subarray(0, 32)
  const prk = extract(sha256, secret, concatBytes(enc, nonce))
  const plain = await open(
    expand(sha256, prk, text.encode('key'), 32),
    expand(sha256, prk, text.encode('nonce'), 12),
    sealed.subarray(32),
  )
  if (!plain) return null
  let end = plain.length
  while (end > 0 && plain[end - 1] === 0) end--
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(plain.subarray(0, end)))
    return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const REASONS = ['invalid', 'window', 'conflict', 'lock']

function toAnswer(body: Record<string, unknown> | null): RelayAnswer | null {
  if (!body) return null
  switch (body.status) {
    case 'submitted':
    case 'duplicate':
      return { status: body.status }
    case 'settled':
      return typeof body.signature === 'string' ? { status: 'settled', signature: body.signature } : null
    case 'retry':
      return typeof body.retryAfter === 'number' ? { status: 'retry', retryAfter: body.retryAfter } : null
    case 'refused':
      return typeof body.reason === 'string' && REASONS.includes(body.reason)
        ? { status: 'refused', reason: body.reason as 'invalid' | 'window' | 'conflict' | 'lock' }
        : null
    default:
      return null
  }
}

/** The answer of `secret` for the blob it sealed, rebuilt from what the outbox keeps. */
export function sealedFrom(blob: Uint8Array, secret: Uint8Array, clusterTag: Uint8Array): SealedRelay {
  const enc = blob.subarray(1, 33)
  return {
    blob,
    clusterTag,
    secret,
    openResponse: async (response) => toAnswer(await openResponseWith(secret, enc, response)),
  }
}

/** Seals `inner` to the gateway key the build pins for `now`; throws when this build has none left. */
export async function sealRelay(
  config: GatewayConfig | null,
  genesisHash: Uint8Array,
  inner: Uint8Array,
  now: number,
  pinned: readonly PinnedKey[] = PINNED_GATEWAY_KEYS,
): Promise<SealedRelay> {
  const key = pinnedKey(config, now, pinned)
  if (!key) throw new Error('This version of the app can no longer send a payment through a nearby phone: update it.')
  const sealed = await sealWithExport(key, 'relay', genesisHash, inner, RELAY_AAD, EXPORT_LABEL)
  const blob = concatBytes(Uint8Array.of(key.keyId), sealed.enc, sealed.ciphertext)
  return sealedFrom(blob, sealed.secret, genesisHash.slice(0, 4))
}
