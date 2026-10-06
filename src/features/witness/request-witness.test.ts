import { describe, expect, it } from 'vitest'
import type { WitnessSettings } from './policy'
import { payerAnswer, requestWitness } from './request-witness'

const settings = (over: Partial<WitnessSettings> = {}): WitnessSettings => ({
  ask: false,
  requireFrom: null,
  answer: false,
  audible: false,
  ...over,
})

describe('what the receiver puts in its request', () => {
  it('asks on the band its setting names, and not at all when its policy is off', () => {
    expect(requestWitness('qr', 1_000_000n, settings())).toBe('none')
    expect(requestWitness('qr', 1_000_000n, settings({ ask: true }))).toBe('ultrasound')
    expect(requestWitness('nearby', 1_000_000n, settings({ ask: true, audible: true }))).toBe('audible')
  })
  it('requires the check from the threshold even when it does not always ask', () => {
    const s = settings({ requireFrom: 5_000_000n })
    expect(requestWitness('qr', 4_999_999n, s)).toBe('none')
    expect(requestWitness('qr', 5_000_000n, s)).toBe('ultrasound')
  })
  it('over NFC a receiver below its threshold does not ask', () => {
    const s = settings({ ask: true, requireFrom: 50_000_000n })
    expect(requestWitness('nfc', 1_000_000n, s)).toBe('none')
    expect(requestWitness('nfc', 50_000_000n, s)).toBe('ultrasound')
  })
})

describe('what the payer does with a request', () => {
  const asked = (witness: 'none' | 'ultrasound' | 'audible') => ({ witness, amount: 1_000_000n })
  it('answers only when asked or when its own setting says so', () => {
    expect(payerAnswer('qr', asked('none'), settings())).toEqual({ policy: 'off', band: null })
    expect(payerAnswer('qr', asked('audible'), settings())).toEqual({ policy: 'auto', band: 'audible' })
    expect(payerAnswer('qr', asked('ultrasound'), settings())).toEqual({ policy: 'auto', band: 'ultrasound' })
  })
  it('does not answer a request that did not ask, even with "Answer nearby checks" on: there is no band to use', () => {
    expect(payerAnswer('qr', asked('none'), settings({ answer: true }))).toEqual({ policy: 'off', band: null })
  })
})
