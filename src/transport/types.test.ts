import { describe, expect, it } from 'vitest'
import { isRetryable, TransportError, type TransportErrorCode } from './types'

describe('isRetryable', () => {
  it.each<[TransportErrorCode, boolean]>([
    ['Timeout', true],
    ['Interrupted', true],
    ['Busy', true],
    ['Cancelled', false],
    ['Unavailable', false],
    ['Malformed', false],
    ['TooLarge', false],
  ])('%s is %s', (code, expected) => {
    expect(isRetryable(new TransportError(code))).toBe(expected)
  })

  it('is false for anything that is not a transport error', () => {
    expect(isRetryable(new Error('Timeout'))).toBe(false)
    expect(isRetryable(undefined)).toBe(false)
  })
})
