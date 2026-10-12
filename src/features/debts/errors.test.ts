import { describe, expect, it } from 'vitest'
import { i18n } from '../../i18n'
import { PairingError } from '../../transport/nearby/pairing'
import { failureText } from './errors'

describe('failureText', () => {
  it('says a Nearby connection that did not happen in a sentence, not as its code', () => {
    for (const reason of [
      'Declined',
      'Rejected',
      'Timeout',
      'Busy',
      'RadioOff',
      'Permission',
      'Unsupported',
      'Error',
    ] as const) {
      const text = failureText(new PairingError(reason), 'Ana')
      expect(text).toBe(i18n.t(`nearby:failed.${reason}`))
      expect(text).not.toBe(reason)
    }
  })
})
