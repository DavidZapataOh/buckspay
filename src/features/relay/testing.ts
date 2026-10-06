import { CipherSuite, HkdfSha256 } from '@hpke/core'
import { Chacha20Poly1305 } from '@hpke/chacha20poly1305'
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519'
import { expand, extract } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js'
import { DEVNET_GENESIS_HASH } from '../../protocol'
import { hpkeInfo, PINNED_GATEWAY_KEYS } from '../../protocol/hpke'
import { testSchedule, testSecret, TEST_START } from '../../test-support/gateway-schedule'
import type { Beacon } from '../mesh/beacon'
import type { NoteDb } from '../notes/db'
import { seal } from './aead'
import type { L2capLink, Seen } from './handoff'
import { type Channel, openHop } from './hop'
import { queueSealed, outboxFor } from './outbox'
import { serveChannel } from './relayer'
import { RELAY_AAD, type RelayAnswer, type SealedRelay, sealedFrom } from './seal'

export { testSchedule as schedule }

const NOW = TEST_START + 100
const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() })

/** The build's pinned schedule, the gateway that holds its secrets, and a configuration that lists them. */
export const testGatewayKey = {
  genesis: DEVNET_GENESIS_HASH,
  now: NOW,
  config: {
    keys: PINNED_GATEWAY_KEYS.map(({ keyId, publicKey }) => ({ keyId, publicKey })),
    fetchedAt: NOW,
  },
}

/** What the gateway does with a blob: open it for `purpose` on the test cluster, with the secret of the key it names. */
export async function openAsGateway(blob: Uint8Array, purpose: string): Promise<Uint8Array> {
  const index = PINNED_GATEWAY_KEYS.findIndex((key) => key.keyId === blob[0])
  const recipientKey = await suite.kem.deserializePrivateKey(testSecret(index).slice().buffer as ArrayBuffer)
  return new Uint8Array(
    await suite.open(
      { recipientKey, enc: blob.slice(1, 33).buffer as ArrayBuffer, info: hpkeInfo(purpose, DEVNET_GENESIS_HASH) },
      blob.slice(33),
      RELAY_AAD,
    ),
  )
}

/** What the gateway does with an answer: seals it for the payer (RFC 9458 section 4.4), zero-padded to 256 bytes. */
export async function sealAnswer(secret: Uint8Array, enc: Uint8Array, answer: RelayAnswer): Promise<Uint8Array> {
  const nonce = sha256(concatBytes(secret, enc))
  const prk = extract(sha256, secret, concatBytes(enc, nonce))
  const body = new Uint8Array(256)
  body.set(new TextEncoder().encode(JSON.stringify(answer)))
  const key = expand(sha256, prk, new TextEncoder().encode('key'), 32)
  const iv = expand(sha256, prk, new TextEncoder().encode('nonce'), 12)
  return concatBytes(nonce, await seal(key, iv, body))
}

export const indexOf = (haystack: Uint8Array, needle: Uint8Array) => {
  outer: for (let at = 0; at + needle.length <= haystack.length; at++) {
    for (let i = 0; i < needle.length; i++) if (haystack[at + i] !== needle[i]) continue outer
    return at
  }
  return -1
}

const CLUSTER = DEVNET_GENESIS_HASH.slice(0, 4)
const KEY_ID = PINNED_GATEWAY_KEYS[0].keyId

const secrets = new Map<string, Uint8Array>()

/** Lets the fake relayers seal an answer for a blob the test sealed itself. */
export const rememberSecret = (blob: Uint8Array, secret: Uint8Array) => void secrets.set(bytesToHex(blob), secret)

/** A sealed settlement of the size of the smallest bucket, which differs with `index`; the gateway is not asked to open it. */
export function sealedFixture(index?: number): SealedRelay
export function sealedFixture(
  index: number,
  options: { withSecrets: true },
): SealedRelay & { payerKey: Uint8Array; amountLe: Uint8Array }
export function sealedFixture(index = 0, options?: { withSecrets: true }) {
  const blob = new Uint8Array(1 + 32 + 1024 + 16)
  blob.set(sha256(Uint8Array.of(index, 1)), 1)
  for (let i = 33; i < blob.length; i += 32) {
    const chunk = sha256(concatBytes(Uint8Array.of(index), Uint8Array.of(i & 255, i >> 8)))
    blob.set(chunk.subarray(0, Math.min(32, blob.length - i)), i)
  }
  blob[0] = KEY_ID
  const secret = sha256(Uint8Array.of(index, 2))
  secrets.set(bytesToHex(blob), secret)
  const sealed: SealedRelay = sealedFrom(blob, secret, CLUSTER)
  return options
    ? {
        ...sealed,
        payerKey: Uint8Array.from({ length: 33 }, (_, i) => 200 - i),
        amountLe: Uint8Array.of(0x40, 0x42, 0x0f, 0, 0, 0, 0, 0),
      }
    : sealed
}

/** Something that is not a settlement: the wrong length or a key the build does not pin. */
export function junk({ length, keyId }: { length?: number; keyId?: number }): Uint8Array {
  const out = new Uint8Array(length ?? 1024 + 49).fill(7)
  out[0] = keyId ?? KEY_ID
  return out
}

export function seen(o: {
  rssi: number
  online?: boolean
  clusterTag?: Uint8Array
  ageSeconds?: number
}): Seen<Beacon> {
  return {
    value: { online: o.online ?? true, clusterTag: o.clusterTag ?? CLUSTER, keyId: KEY_ID, psm: 0x81 },
    address: `rssi:${o.rssi}`,
    rssi: o.rssi,
    ageSeconds: o.ageSeconds ?? 0,
  }
}

/** A queued message of the fixture, as the sender's outbox keeps it. */
export async function queueFixture(db: NoteDb) {
  const sealed = sealedFixture(9)
  await queueSealed(db, { id: sha256(sealed.blob), ref: 'ab'.repeat(32), sealed, now: 10, expiresAt: 100_000 })
  const row = await outboxFor(db, 'ab'.repeat(32))
  if (!row) throw new Error('the fixture was not queued')
  return row
}

type Pipe = {
  push(bytes: Uint8Array): void
  close(): void
  read(length: number, timeoutMs: number): Promise<Uint8Array>
}

function pipe(): Pipe {
  let buffer = new Uint8Array(0)
  let closed = false
  let wake: (() => void) | undefined
  return {
    push(bytes) {
      buffer = concatBytes(buffer, bytes)
      wake?.()
    },
    close() {
      closed = true
      wake?.()
    },
    async read(length, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (buffer.length < length) {
        if (closed) throw new Error('closed')
        if (Date.now() >= deadline) throw new Error('timeout')
        await new Promise<void>((resolve) => {
          wake = resolve
          setTimeout(resolve, Math.min(50, deadline - Date.now()))
        })
      }
      const out = buffer.slice(0, length)
      buffer = buffer.slice(length)
      return out
    },
  }
}

export type FakeL2cap = L2capLink & { connectedRssi(): number[]; wireBytes(): Uint8Array }

/**
 * Relayers on the other end of the link: each answers a stored blob with `storeReply` (or the next of `storeReplies`),
 * then sends the sealed `answer`, or `rawAnswer` as it is. Their side runs the same hop wrapper the app does.
 */
export function fakeL2cap(o: {
  storeReply?: number
  storeReplies?: number[]
  answer?: RelayAnswer
  rawAnswer?: Uint8Array
}): FakeL2cap {
  const connected: number[] = []
  let wire = new Uint8Array(0)
  let call = 0
  return {
    listen: async () => 0x81,
    async connect(address) {
      const reply = o.storeReplies?.[call++] ?? o.storeReply ?? 0x00
      connected.push(Number(address.split(':')[1]))
      const [toRelayer, toApp] = [pipe(), pipe()]
      const relayer: Channel = {
        read: (length, timeout) => toRelayer.read(length, timeout),
        write: async (bytes) => toApp.push(bytes),
        close: () => toApp.close(),
      }
      void (async () => {
        try {
          const hop = await openHop(relayer, 'responder')
          const blob = await hop.receive(1_000)
          await hop.send(Uint8Array.of(reply))
          if (reply === 0x01 && o.rawAnswer) await hop.send(o.rawAnswer)
          else if (reply === 0x01 && o.answer) {
            const response = await sealAnswer(
              secrets.get(bytesToHex(blob)) ?? new Uint8Array(32),
              blob.slice(1, 33),
              o.answer,
            )
            await hop.send(response)
          }
        } catch {
          // The app closed or gave up: nothing to answer.
        } finally {
          relayer.close()
        }
      })()
      return {
        read: (length, timeout) => toApp.read(length, timeout),
        write: async (bytes) => {
          wire = concatBytes(wire, bytes)
          toRelayer.push(bytes)
        },
        close: () => toRelayer.close(),
      }
    },
    connectedRssi: () => connected,
    wireBytes: () => wire,
  }
}

/** Every byte the database holds, tables and indexes alike: what a relayer would give away if it was read. */
export async function dumpBytes(db: NoteDb): Promise<Uint8Array> {
  const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
  const out: number[] = []
  for (const { name } of tables) {
    for (const row of await db.all<Record<string, unknown>>(`SELECT * FROM "${name}"`)) {
      for (const value of Object.values(row)) {
        if (value instanceof Uint8Array) out.push(...value)
        else if (typeof value === 'string') out.push(...new TextEncoder().encode(value))
        else if (typeof value === 'number') out.push(...new TextEncoder().encode(String(value)))
      }
    }
  }
  return Uint8Array.from(out)
}

/**
 * A link whose far end is a relayer running `serveChannel` over `db`, which posts through `post`: the whole way a
 * payment goes from a phone without internet to the gateway and its sealed answer back.
 */
export function relayerLink(
  db: NoteDb,
  post: (blob: Uint8Array) => Promise<Uint8Array>,
  now: () => number,
  online = true,
): L2capLink {
  return {
    listen: async () => 0x81,
    async connect(address) {
      const [toRelayer, toApp] = [pipe(), pipe()]
      const relayer: Channel = {
        read: (length, timeout) => toRelayer.read(length, timeout),
        write: async (bytes) => toApp.push(bytes),
        close: () => toApp.close(),
      }
      void serveChannel(db, relayer, address, post, now, online)
      return {
        read: (length, timeout) => toApp.read(length, timeout),
        write: async (bytes) => toRelayer.push(bytes),
        close: () => toRelayer.close(),
      }
    },
  }
}

/** The reading of an inner message the gateway does: `issue` and `spends` out of the padded layout. */
export function parseInner(plain: Uint8Array): { issue: Uint8Array; spends: Uint8Array[] } {
  const view = new DataView(plain.buffer, plain.byteOffset)
  const issueLength = view.getUint16(2)
  const issue = plain.slice(4, 4 + issueLength)
  let at = 4 + issueLength
  const count = plain[at++]
  const spends: Uint8Array[] = []
  for (let i = 0; i < count; i++) {
    const length = view.getUint16(at)
    spends.push(plain.slice(at + 2, at + 2 + length))
    at += 2 + length
  }
  return { issue, spends }
}
