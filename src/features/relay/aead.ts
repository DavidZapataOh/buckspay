import { Chacha20Poly1305 } from '@hpke/chacha20poly1305'

const aead = new Chacha20Poly1305()
const NO_AAD = new Uint8Array(0)

/** ChaCha20-Poly1305 with a 12-byte nonce, as RFC 8439 and the hand-off wrapper and the relay answers use it. */
export const seal = async (key: Uint8Array, nonce: Uint8Array, data: Uint8Array) =>
  new Uint8Array(await aead.createEncryptionContext(key).seal(nonce, data, NO_AAD))

/** `null` when the tag does not verify. */
export async function open(key: Uint8Array, nonce: Uint8Array, data: Uint8Array): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await aead.createEncryptionContext(key).open(nonce, data, NO_AAD))
  } catch {
    return null
  }
}
