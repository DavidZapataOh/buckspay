import { i18n } from '../../i18n'
import { describe, expect, it } from 'vitest'
import { resources } from '../../i18n/resources'

describe('remote copy', () => {
  it('never claims delivery, speed, privacy or a hidden location it cannot show', () => {
    const all = JSON.stringify(resources.en.remote).toLowerCase()
    for (const w of [
      'instant',
      'guaranteed',
      'anonymous',
      'private',
      'sent!',
      'untraceable',
      'location is hidden',
      'no one knows where',
    ])
      expect(all).not.toContain(w)
  })
  it('says what happens when nobody passes the payment on', () => {
    expect(
      i18n.t('remote:reviewLine', { name: 'Ana', amount: '5.00', symbol: 'USDC', deadline: 'tomorrow' }),
    ).toContain("it isn't paid and the money stays yours")
    expect(i18n.t('remote:status.expired')).toBe('Not delivered, money kept')
  })
})
