import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { MAX_MESSAGE_BYTES } from '../../transport/types'
import { open, seal } from '../relay/aead'

export type Invite = { session: Uint8Array; secret: Uint8Array }

export const INVITE_PREFIX = 'buckspay://netting/join?i='
export const HOST = 0
/** The sender id of a Join, before the roster gives the joiner an index. */
export const JOINING = 0xff

export type ChannelErrorCode = 'BadInvite' | 'Malformed' | 'Forged' | 'Replayed' | 'UnknownSender'

export class ChannelError extends Error {
  constructor(readonly code: ChannelErrorCode) {
    super(code)
    this.name = 'ChannelError'
  }
}

const KEY_INFO = utf8ToBytes('buckspay netting')
const TAG_INFO = utf8ToBytes('buckspay netting tag')
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const FRAME_HEADER = 9
const TAG_LEN = 16
const MIN_FRAME = FRAME_HEADER + 1 + TAG_LEN
const MAX_FRAME = MAX_MESSAGE_BYTES + MIN_FRAME
const MAX_MEMBERS = 7

function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += ALPHABET[(chunk >> 18) & 63] + ALPHABET[(chunk >> 12) & 63]
    if (i + 1 < bytes.length) out += ALPHABET[(chunk >> 6) & 63]
    if (i + 2 < bytes.length) out += ALPHABET[chunk & 63]
  }
  return out
}

function fromBase64Url(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null
  const values: number[] = []
  for (const char of text) {
    const value = ALPHABET.indexOf(char)
    if (value < 0) return null
    values.push(value)
  }
  const out: number[] = []
  for (let i = 0; i < values.length; i += 4) {
    const chunk = (values[i] << 18) | ((values[i + 1] ?? 0) << 12) | ((values[i + 2] ?? 0) << 6) | (values[i + 3] ?? 0)
    out.push((chunk >> 16) & 255)
    if (i + 2 < values.length) out.push((chunk >> 8) & 255)
    if (i + 3 < values.length) out.push(chunk & 255)
  }
  return Uint8Array.from(out)
}

export function newInvite(random: (n: number) => Uint8Array): Invite {
  return { session: random(32), secret: random(32) }
}

export const encodeInvite = (invite: Invite): string => INVITE_PREFIX + toBase64Url(concatBytes(invite.session, invite.secret))

export function decodeInvite(text: string): Invite {
  if (!text.startsWith(INVITE_PREFIX)) throw new ChannelError('BadInvite')
  const bytes = fromBase64Url(text.slice(INVITE_PREFIX.length))
  if (!bytes || bytes.length !== 64) throw new ChannelError('BadInvite')
  return { session: bytes.slice(0, 32), secret: bytes.slice(32) }
}

/** 8 bytes: the Nearby advertisement info; HKDF-SHA256(secret, "buckspay netting tag" ‖ session). */
export const sessionTag = (invite: Invite): Uint8Array =>
  hkdf(sha256, invite.secret, new Uint8Array(0), concatBytes(TAG_INFO, invite.session), 8)

export type Opened = { sender: number; type: number; body: Uint8Array }

const counterBytes = (counter: bigint) => {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, counter, true)
  return out
}

/** Sealed per-sender frames: `sender u8 ‖ counter u64 LE ‖ ChaCha20-Poly1305(type ‖ body)`. */
export class SessionChannel {
  #me: number
  #next: bigint
  readonly #keys = new Map<number, Uint8Array>()
  readonly #seen = new Map<string, bigint>()

  constructor(
    private readonly invite: Invite,
    me: number,
    private readonly clock: () => number = Date.now,
  ) {
    this.#me = me
    this.#next = BigInt(Math.floor(this.clock())) * 1024n
  }

  get me(): number {
    return this.#me
  }

  /** Gives a joining channel its roster index, once. */
  assign(index: number): void {
    if (this.#me !== JOINING || !Number.isInteger(index) || index < 1 || index > MAX_MEMBERS) throw new ChannelError('Malformed')
    this.#me = index
  }

  async seal(type: number, body: Uint8Array): Promise<Uint8Array> {
    const floor = BigInt(Math.floor(this.clock())) * 1024n
    const counter = this.#next > floor ? this.#next : floor
    this.#next = counter + 1n
    const sealed = await seal(this.#key(this.#me), nonceOf(counter), concatBytes(Uint8Array.of(type), body))
    return concatBytes(Uint8Array.of(this.#me), counterBytes(counter), sealed)
  }

  /** `link` names the connection a JOINING frame came on (its counter is tracked per link); else per sender. */
  async open(frame: Uint8Array, link = ''): Promise<Opened> {
    if (frame.length < MIN_FRAME || frame.length > MAX_FRAME) throw new ChannelError('Malformed')
    const sender = frame[0]
    if (sender !== JOINING && sender > MAX_MEMBERS) throw new ChannelError('UnknownSender')
    const counter = new DataView(frame.buffer, frame.byteOffset + 1, 8).getBigUint64(0, true)
    const plain = await open(this.#key(sender), nonceOf(counter), frame.slice(FRAME_HEADER))
    if (!plain) throw new ChannelError('Forged')
    const track = sender === JOINING ? `j:${link}` : `s:${sender}`
    const last = this.#seen.get(track)
    if (last !== undefined && counter <= last) throw new ChannelError('Replayed')
    this.#seen.set(track, counter)
    return { sender, type: plain[0], body: plain.slice(1) }
  }

  #key(sender: number): Uint8Array {
    let key = this.#keys.get(sender)
    if (!key) {
      key = hkdf(sha256, this.invite.secret, new Uint8Array(0), concatBytes(KEY_INFO, this.invite.session, Uint8Array.of(sender)), 32)
      this.#keys.set(sender, key)
    }
    return key
  }
}

const nonceOf = (counter: bigint) => concatBytes(new Uint8Array(4), counterBytes(counter))
