import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it, vi } from 'vitest'
import { CHANNEL_AUDIBLE, CHANNEL_ULTRASOUND, decodeEvidence } from '../../protocol'
import { type WitnessRole, type WitnessStore } from './port'
import { createAppWitnessPort, payerBand } from './app-port'
import type { Modem } from './session'
import { createRoom, FAST, PAYMENT_ID, party, realClock, softSigner, WITNESS_DOMAIN } from './testing/world'

const payer = party(1)
const shop = party(2)

function store(): WitnessStore {
  const kept = new Map<string, Uint8Array>()
  const key = (id: Uint8Array, role: WitnessRole) => `${role}:${bytesToHex(id)}`
  return {
    facts: async () => ({ payerKey: payer.key, receiverKey: shop.key }),
    stored: async (id, role) => kept.get(key(id, role)) ?? null,
    record: async (id, role, evidence) => void kept.set(key(id, role), evidence),
    countSignature: async () => 1,
  }
}

const settings = (audible: boolean) => () => ({ ask: true, requireFrom: null, answer: true, audible })
const phone = (modem: (band: 'ultrasound' | 'audible') => Modem, sign: ReturnType<typeof softSigner>) => ({
  modem,
  sign,
  witnessDomain: WITNESS_DOMAIN,
  clock: realClock,
  config: FAST,
})

describe('payer band', () => {
  it('follows the request, and is null when no check was asked', () => {
    expect(payerBand({ witness: 'none' })).toBeNull()
    expect(payerBand({ witness: 'ultrasound' })).toBe('ultrasound')
    expect(payerBand({ witness: 'audible' })).toBe('audible')
  })
})

describe('the app port', () => {
  it.each([
    ['ultrasound', CHANNEL_ULTRASOUND],
    ['audible', CHANNEL_AUDIBLE],
  ] as const)('runs a check on the %s band and stores a claim with its channel', async (band, channel) => {
    const [a, b] = createRoom()
    const bands: string[] = []
    const modemFor = (modem: Modem) => (used: 'ultrasound' | 'audible') => (bands.push(used), modem)
    const receiver = createAppWitnessPort(store(), settings(band === 'audible'), phone(modemFor(a), softSigner(shop)))
    const sender = createAppWitnessPort(store(), settings(false), phone(modemFor(b), softSigner(payer)))
    const [r, p] = await Promise.all([
      receiver.attach(PAYMENT_ID, 'receiver'),
      sender.attach(PAYMENT_ID, 'payer', band),
    ])
    expect([r.status, p.status]).toEqual(['seen', 'seen'])
    expect(decodeEvidence(r.evidence!).channel).toBe(channel)
    expect(bands).toEqual([band, band])
  })

  it('one attempt per message: a second attach while running returns the same result', async () => {
    const [a] = createRoom()
    const modem = vi.fn(() => a)
    const port = createAppWitnessPort(store(), settings(false), phone(modem, softSigner(shop)))
    const first = port.attach(PAYMENT_ID, 'receiver')
    const second = port.attach(PAYMENT_ID, 'receiver')
    port.cancel(PAYMENT_ID)
    expect(await first).toEqual(await second)
    expect(modem).toHaveBeenCalledOnce()
  })
})
