import { describe, expect, it } from 'vitest'
import { i18n } from '../../i18n'
import { PayError } from '../../payment/pay'
import { payErrorKey } from './copy'

describe('copy', () => {
  it('says a screen lock is needed to pay the threshold or more, the rule the app applies', () => {
    expect(i18n.t('payment:payError.NoScreenLock', { amount: '20.00', symbol: 'USDC' })).toBe(
      'To pay 20.00 USDC or more, set a screen lock first. No money moved.',
    )
  })

  it('refuses to render a sentence with a value missing', () => {
    expect(() => i18n.t('payment:review.title', { amount: '5.00' })).toThrow('No value for symbol')
  })

  it('names the medium on the request screen and never asks to scan when there is nothing to scan', () => {
    expect(i18n.t('payment:receive.requestTitle.qr')).toBe('Scan this')
    expect(i18n.t('payment:receive.requestTitle.nfc')).toBe('Touch phones')
    expect(i18n.t('payment:receive.requestTitle.nearby')).toBe('Keep phones close')
    for (const medium of ['nfc', 'nearby'] as const) {
      expect(i18n.t(`payment:receive.requestTitle.${medium}`).toLowerCase()).not.toMatch(/scan|camera|code/)
    }
  })

  it('does not tell anyone to use the camera while waiting on Tap or Nearby', () => {
    expect(i18n.t('transport:waitingForRequest').toLowerCase()).not.toMatch(/scan|camera|code/)
    expect(i18n.t('payment:receive.waitingForPayment').toLowerCase()).not.toMatch(/scan|camera|code/)
  })

  it('says only what the bond does: it is destroyed if the same money is signed twice', () => {
    expect(i18n.t('payment:receive.bondNote')).toContain('their security deposit is destroyed')
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
