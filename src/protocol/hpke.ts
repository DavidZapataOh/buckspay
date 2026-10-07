import { Chacha20Poly1305 } from '@hpke/chacha20poly1305'
import { CipherSuite, HkdfSha256 } from '@hpke/core'
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519'

/** RFC 9180 identifiers of the one suite the gateway accepts. */
export const HPKE_SUITE = { kemId: 0x0020, kdfId: 0x0001, aeadId: 0x0003 } as const

/** A key of the gateway's `/v1/hpke-config`. */
export type GatewayKey = { keyId: number; kemId: number; kdfId: number; aeadId: number; publicKey: string }

/** A message sealed to a gateway key. */
export type Sealed = { keyId: number; enc: Uint8Array; ciphertext: Uint8Array }

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
})

/**
 * The HPKE `info` of a message for `purpose` on the cluster with `genesisHash`: a sealed message
 * opens only for the purpose and cluster it was sealed for.
 */
export function hpkeInfo(purpose: string, genesisHash: Uint8Array): Uint8Array {
  const label = new TextEncoder().encode(`buckspay/hpke/v1\0${purpose}\0`)
  const info = new Uint8Array(label.length + genesisHash.length)
  info.set(label)
  info.set(genesisHash, label.length)
  return info
}

/** A gateway key the build trusts, with the slot of the schedule it is valid for, in seconds since the epoch. */
export type PinnedKey = { keyId: number; publicKey: Uint8Array; notBefore: number; notAfter: number }

/** The keys `/v1/hpke-config` listed when it was last fetched, and when. */
export type GatewayConfig = { keys: readonly Pick<PinnedKey, 'keyId' | 'publicKey'>[]; fetchedAt: number }

/** Seconds a sealed message can still be opened after its key's slot ends: the longest a note can wait. */
export const RETIRED_GRACE = 72 * 3_600
/** Seconds after the next slot begins during which the older key is still preferred: the gateway's clock may lag. */
export const PREFER_OLDER = 3_600
/** Seconds a fetched configuration can be used to revoke a pinned key. */
export const CONFIG_FRESH = 86_400

const fromBase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))

/**
 * The gateway keys this build trusts, fixed when its bundle is made: the current slot and the next twelve
 * (`[{ keyId, publicKey, notBefore, notAfter }]`, public keys in base64).
 */
export const PINNED_GATEWAY_KEYS: readonly PinnedKey[] = (
  JSON.parse(process.env.EXPO_PUBLIC_GATEWAY_HPKE_KEYS || '[]') as (Omit<PinnedKey, 'publicKey'> & {
    publicKey: string
  })[]
).map((key) => ({ ...key, publicKey: fromBase64(key.publicKey) }))

const sameKey = (a: Pick<PinnedKey, 'keyId' | 'publicKey'>, b: Pick<PinnedKey, 'keyId' | 'publicKey'>) =>
  a.keyId === b.keyId &&
  a.publicKey.length === b.publicKey.length &&
  a.publicKey.every((byte, i) => byte === b.publicKey[i])

/**
 * The pinned key to seal to at `now`: the oldest key whose slot began and ended less than an hour ago, else the
 * newest whose slot holds `now`. A key the build does not pin is never used, whatever the gateway lists; a pinned
 * key a fresh configuration no longer lists is revoked; a key more than `RETIRED_GRACE` past its slot is dead.
 */
export function pinnedKey(
  config: GatewayConfig | null,
  now: number,
  pinned: readonly PinnedKey[] = PINNED_GATEWAY_KEYS,
): PinnedKey | null {
  const fresh = config !== null && now - config.fetchedAt <= CONFIG_FRESH
  const usable = pinned
    .filter(
      (key) =>
        key.notBefore <= now &&
        now < key.notAfter + RETIRED_GRACE &&
        (!fresh || config.keys.some((listed) => sameKey(listed, key))),
    )
    .sort((a, b) => a.notBefore - b.notBefore)
  return usable.find((key) => now < key.notAfter + PREFER_OLDER) ?? usable.at(-1) ?? null
}

/** Seals `plaintext` to a pinned gateway key for `purpose` on the cluster with `genesisHash`. */
export async function sealToGateway(
  key: { keyId: number; publicKey: string | Uint8Array },
  purpose: string,
  genesisHash: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Sealed> {
  const sealed = await sealWithExport(key, purpose, genesisHash, plaintext, aad, new Uint8Array(0))
  return { keyId: sealed.keyId, enc: sealed.enc, ciphertext: sealed.ciphertext }
}

/** As `sealToGateway`, and exports 32 bytes of secret under `label` that only the gateway can also derive (RFC 9180 section 5.3). */
export async function sealWithExport(
  key: { keyId: number; publicKey: string | Uint8Array },
  purpose: string,
  genesisHash: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
  label: Uint8Array,
): Promise<Sealed & { secret: Uint8Array }> {
  const publicKey = typeof key.publicKey === 'string' ? fromBase64(key.publicKey) : key.publicKey
  const recipientPublicKey = await suite.kem.deserializePublicKey(publicKey.slice().buffer as ArrayBuffer)
  const sender = await suite.createSenderContext({ recipientPublicKey, info: hpkeInfo(purpose, genesisHash) })
  const ct = await sender.seal(plaintext.slice().buffer as ArrayBuffer, aad.slice().buffer as ArrayBuffer)
  const secret = new Uint8Array(await sender.export(label.slice().buffer as ArrayBuffer, 32))
  return { keyId: key.keyId, enc: new Uint8Array(sender.enc), ciphertext: new Uint8Array(ct), secret }
}

/** Opens a message sealed to the X25519 key `secret` for `purpose` on the cluster with `genesisHash`, or `null` if it is not for that key. */
export async function openSealed(
  secret: Uint8Array,
  sealed: { enc: Uint8Array; ciphertext: Uint8Array },
  purpose: string,
  genesisHash: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array | null> {
  try {
    const recipientKey = await suite.kem.deserializePrivateKey(secret.slice().buffer as ArrayBuffer)
    const plain = await suite.open(
      { recipientKey, enc: sealed.enc.slice().buffer as ArrayBuffer, info: hpkeInfo(purpose, genesisHash) },
      sealed.ciphertext.slice().buffer as ArrayBuffer,
      aad.slice().buffer as ArrayBuffer,
    )
    return new Uint8Array(plain)
  } catch {
    return null
  }
}
