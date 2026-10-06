import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { open, seal } from './aead'

/** What a Bluetooth L2CAP channel gives the app: bytes in order, read exactly, with a timeout. */
export interface Channel {
  /** Exactly `length` bytes; rejects on a timeout or when the peer closed. */
  read(length: number, timeoutMs: number): Promise<Uint8Array>
  write(bytes: Uint8Array): Promise<void>
  close(): void
}

/** The largest frame either side sends: a relayed blob plus the tag of the hop. */
export const MAX_FRAME = 8_241 + 16
const INFO = new TextEncoder().encode('buckspay/hop/v1')

export type Hop = {
  send(plain: Uint8Array): Promise<void>
  receive(timeoutMs: number): Promise<Uint8Array>
}

const nonce = (counter: number) => {
  const out = new Uint8Array(12)
  new DataView(out.buffer).setBigUint64(4, BigInt(counter))
  return out
}

/**
 * Wraps a channel in an ephemeral X25519 exchange: both sides send a 32-byte public key, and every later frame
 * (`len u32 ‖ ChaCha20-Poly1305`) is sealed under a key of that exchange, so the bytes on the air differ per hop
 * for the same message. The exchange is not authenticated: it defeats a passive sniffer, not a relay in the middle.
 */
export async function openHop(
  channel: Channel,
  role: 'initiator' | 'responder',
  handshakeTimeoutMs = 5_000,
): Promise<Hop> {
  const secret = x25519.utils.randomSecretKey()
  const mine = x25519.getPublicKey(secret)
  let theirs: Uint8Array
  if (role === 'initiator') {
    await channel.write(mine)
    theirs = await channel.read(32, handshakeTimeoutMs)
  } else {
    theirs = await channel.read(32, handshakeTimeoutMs)
    await channel.write(mine)
  }
  const [initiator, responder] = role === 'initiator' ? [mine, theirs] : [theirs, mine]
  const keys = hkdf(sha256, x25519.getSharedSecret(secret, theirs), concatBytes(initiator, responder), INFO, 64)
  const [sendKey, receiveKey] =
    role === 'initiator' ? [keys.subarray(0, 32), keys.subarray(32)] : [keys.subarray(32), keys.subarray(0, 32)]
  let sent = 0
  let received = 0
  return {
    async send(plain) {
      const sealed = await seal(sendKey, nonce(sent++), plain)
      const header = new Uint8Array(4)
      new DataView(header.buffer).setUint32(0, sealed.length)
      await channel.write(concatBytes(header, sealed))
    },
    async receive(timeoutMs) {
      const header = await channel.read(4, timeoutMs)
      const length = new DataView(header.buffer, header.byteOffset).getUint32(0)
      if (length > MAX_FRAME) throw new Error('frame too large')
      const plain = await open(receiveKey, nonce(received++), await channel.read(length, timeoutMs))
      if (!plain) throw new Error('frame does not open')
      return plain
    },
  }
}
