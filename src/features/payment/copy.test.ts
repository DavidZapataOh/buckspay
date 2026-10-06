import { describe, expect, it } from 'vitest'
import { PayError } from '../../payment/pay'
import { howCopy } from '../transport/copy'
import { copy, payErrorKey, text } from './copy'

const strings = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : Object.values(value as object).flatMap(strings)

describe('copy', () => {
  it('has no placeholder left unfilled in any rendered string', () => {
    for (const template of strings(copy)) {
      const names = [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1])
      const rendered = text(template, Object.fromEntries(names.map((name) => [name, 'x'])))
      expect(rendered).not.toContain('{')
      expect(rendered).not.toContain('}')
    }
  })

  it('refuses to render a sentence with a value missing', () => {
    expect(() => text(copy.review.title, { amount: '5.00' })).toThrow('{symbol}')
  })

  it('never says a payment is protected, insured or bounded', () => {
    for (const sentence of strings(copy)) {
      expect(sentence.toLowerCase()).not.toMatch(/protect|insur|bounded|guarantee/)
    }
  })

  it('names the medium on the request screen and never asks to scan when there is nothing to scan', () => {
    expect(copy.receive.requestTitle.qr).toBe('Ask the payer to scan this code')
    expect(copy.receive.requestTitle.nfc).toBe('Hold the phones together')
    expect(copy.receive.requestTitle.nearby).toBe('Keep the phones close and wait for the payer')
    for (const medium of ['nfc', 'nearby'] as const) {
      expect(copy.receive.requestTitle[medium].toLowerCase()).not.toMatch(/scan|camera|code/)
    }
  })

  it('does not tell anyone to use the camera while waiting on Tap or Nearby', () => {
    expect(howCopy.waitingForRequest.toLowerCase()).not.toMatch(/scan|camera|code/)
    expect(copy.receive.waitingForPayment.toLowerCase()).not.toMatch(/scan|camera|code/)
  })

  it('says only what the bond does: it is destroyed if the same money is signed twice', () => {
    expect(copy.receive.bondNote).toContain('destroyed if they sign the same money twice')
  })

  it('tells the person what to do for each way a signature fails', () => {
    const failed = (code?: string) => payErrorKey(new PayError('SignFailed'), code)
    expect(failed('ERR_DEVICE_LOCKED')).toBe('Locked')
    expect(failed('ERR_KEY_UNAVAILABLE')).toBe('NoKey')
    expect(failed('ERR_NOTE_GUARD_UNAVAILABLE')).toBe('NoKey')
    expect(failed('ERR_OTHER')).toBe('SignFailed')
    expect(failed()).toBe('SignFailed')
    expect(payErrorKey(new PayError('Declined'))).toBe('Declined')
    expect(payErrorKey(new PayError('Declined', 'NoScreenLock'))).toBe('NoScreenLock')
    expect(payErrorKey(new PayError('SendFailed'))).toBe('SendFailed')
  })
})
