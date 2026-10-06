import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { CHANNEL_ULTRASOUND, decodeEvidence, verifyWitness } from '../../protocol'
import { createWitnessPort, type WitnessRole, type WitnessStore } from './port'
import type { SessionDeps } from './session'
import { createRoom, FAST, PAYMENT_ID, party, realClock, softSigner, WITNESS_DOMAIN } from './testing/world'

const payer = party(1)
const shop = party(2)

function memoryStore(known: { payer?: boolean; receiver?: boolean } = { payer: true, receiver: true }) {
  const kept = new Map<string, Uint8Array>()
  const signatures = new Map<string, number>()
  const key = (id: Uint8Array, role: WitnessRole) => `${role}:${bytesToHex(id)}`
  const store: WitnessStore = {
    facts: async (_, role) => (known[role] ? { payerKey: payer.key, receiverKey: shop.key } : null),
    stored: async (id, role) => kept.get(key(id, role)) ?? null,
    record: async (id, role, evidence) => void kept.set(key(id, role), evidence),
    countSignature: async (id) => {
      const next = (signatures.get(bytesToHex(id)) ?? 0) + 1
      signatures.set(bytesToHex(id), next)
      return next
    },
  }
  return { store, kept, signatures, key }
}

const deps = (modem: SessionDeps['modem']): SessionDeps => ({
  modem,
  clock: realClock,
  random: (n) => crypto.getRandomValues(new Uint8Array(n)),
  config: FAST,
  witnessDomain: WITNESS_DOMAIN,
  channel: CHANNEL_ULTRASOUND,
})

function ports(room = createRoom(), known?: { payer?: boolean; receiver?: boolean }) {
  const r = memoryStore(known)
  const p = memoryStore(known)
  const receiver = createWitnessPort({ ...deps(room[0]), store: r.store, sign: softSigner(shop) })
  const payerPort = createWitnessPort({ ...deps(room[1]), store: p.store, sign: softSigner(payer) })
  return { receiver, payerPort, r, p, room }
}

describe('the witness port', () => {
  it('runs both roles, stores verifiable evidence on each side and reports seen', async () => {
    const { receiver, payerPort, r, p } = ports()
    const [a, b] = await Promise.all([receiver.attach(PAYMENT_ID, 'receiver'), payerPort.attach(PAYMENT_ID, 'payer')])
    expect([a.status, b.status]).toEqual(['seen', 'seen'])
    const stored = r.kept.get(r.key(PAYMENT_ID, 'receiver'))!
    expect(() => verifyWitness(WITNESS_DOMAIN, decodeEvidence(stored))).not.toThrow()
    expect(p.kept.get(p.key(PAYMENT_ID, 'payer'))).toEqual(stored)
  })

  it('is unavailable for a payment the store does not know, and plays nothing', async () => {
    const { receiver, room } = ports(createRoom(), { receiver: false, payer: false })
    expect(await receiver.attach(new Uint8Array(32).fill(3), 'receiver')).toEqual({ status: 'unavailable' })
    expect(room[0].played).toHaveLength(0)
  })

  it('returns the stored evidence for a payment it already witnessed, without playing anything', async () => {
    const { receiver, payerPort, room } = ports()
    const [first] = await Promise.all([receiver.attach(PAYMENT_ID, 'receiver'), payerPort.attach(PAYMENT_ID, 'payer')])
    const played = room[0].played.length
    const again = await receiver.attach(PAYMENT_ID, 'receiver')
    expect(again).toEqual(first)
    expect(room[0].played.length).toBe(played)
  })

  it('shares one attempt between concurrent calls for the same payment and role', async () => {
    const { receiver, payerPort } = ports()
    const [x, y] = [receiver.attach(PAYMENT_ID, 'receiver'), receiver.attach(PAYMENT_ID, 'receiver')]
    await payerPort.attach(PAYMENT_ID, 'payer')
    expect(await x).toEqual(await y)
  })

  it('stores nothing for an attempt that was not seen, so the receiver can try again', async () => {
    const { receiver, r } = ports()
    expect((await receiver.attach(PAYMENT_ID, 'receiver')).status).toBe('not-seen')
    expect(r.kept.size).toBe(0)
  })

  it('cancel ends a running attempt as not seen', async () => {
    const { receiver } = ports()
    const pending = receiver.attach(PAYMENT_ID, 'receiver')
    setTimeout(() => receiver.cancel(PAYMENT_ID), 30)
    expect((await pending).status).toBe('not-seen')
  })
})
