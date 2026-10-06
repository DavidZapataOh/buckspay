import { describe, expect, it } from 'vitest'
import { type PolicyInput, witnessPolicy, type WitnessSettings } from './policy'

const settings = (over: Partial<WitnessSettings> = {}): WitnessSettings => ({
  ask: false,
  requireFrom: null,
  answer: false,
  ...over,
})
const input = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  role: 'receiver',
  transport: 'qr',
  amount: 5_000_000n,
  settings: settings(),
  ...over,
})

describe('witnessPolicy', () => {
  it('is off for everyone by default', () => {
    expect(witnessPolicy(input())).toBe('off')
    expect(witnessPolicy(input({ role: 'payer' }))).toBe('off')
  })

  it('receiver: asks over QR and Nearby when it is turned on', () => {
    for (const transport of ['qr', 'nearby'] as const) {
      expect(witnessPolicy(input({ transport, settings: settings({ ask: true }) }))).toBe('auto')
    }
  })

  it('receiver: does not ask over NFC, which is its own nearness, unless it requires the check', () => {
    expect(witnessPolicy(input({ transport: 'nfc', settings: settings({ ask: true }) }))).toBe('off')
    expect(
      witnessPolicy(input({ transport: 'nfc', amount: 20_000_000n, settings: settings({ requireFrom: 20_000_000n }) })),
    ).toBe('require')
  })

  it('receiver: requires the check from the threshold up, on any transport, even when asking is off', () => {
    const s = settings({ requireFrom: 20_000_000n })
    expect(witnessPolicy(input({ amount: 19_999_999n, settings: s }))).toBe('off')
    for (const transport of ['qr', 'nfc', 'nearby'] as const) {
      expect(witnessPolicy(input({ transport, amount: 20_000_000n, settings: s }))).toBe('require')
    }
  })

  it('payer: answers when the person turned answering on or when the receiver asked', () => {
    expect(witnessPolicy(input({ role: 'payer', settings: settings({ answer: true }) }))).toBe('auto')
    expect(witnessPolicy(input({ role: 'payer', requested: true }))).toBe('auto')
  })

  it('payer: never requires: a payer has nothing to gate', () => {
    expect(
      witnessPolicy(
        input({ role: 'payer', amount: 1_000_000_000n, settings: settings({ requireFrom: 1n, answer: true }) }),
      ),
    ).toBe('auto')
  })
})
