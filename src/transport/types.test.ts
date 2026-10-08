import { describe, expect, it } from 'vitest'
import { isRetryable, MessageKind, TransportError, type TransportErrorCode } from './types'

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

describe('MessageKind', () => {
  it('debts use kind 6 and kind 7 stays free', () => {
    const kinds = Object.values(MessageKind)
    expect(MessageKind.Debts).toBe(6)
    expect(kinds).not.toContain(7)
    expect(new Set(kinds).size).toBe(kinds.length)
    expect(Math.max(...kinds)).toBeLessThanOrEqual(7)
  })
})
