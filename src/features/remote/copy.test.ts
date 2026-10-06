import { describe, expect, it } from 'vitest'
import { remoteCopy } from './copy'

describe('remote copy', () => {
  it('never claims delivery, speed, privacy or a hidden location it cannot show', () => {
    const all = JSON.stringify(remoteCopy).toLowerCase()
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
    expect(remoteCopy.reviewLine).toContain('it is not paid and the money stays yours')
    expect(remoteCopy.status.expired).toBe('Not delivered, money kept')
  })
})
