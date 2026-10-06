import { describe, expect, it } from 'vitest'
import { formatCountdown, formatDuration } from './format-duration'

describe('durations', () => {
  it('say hours, minutes or seconds, in the plural only when needed', () => {
    expect(formatDuration(3600)).toBe('1 hour')
    expect(formatDuration(7200)).toBe('2 hours')
    expect(formatDuration(5400)).toBe('1 hour 30 minutes')
    expect(formatDuration(60)).toBe('1 minute')
    expect(formatDuration(600)).toBe('10 minutes')
    expect(formatDuration(45)).toBe('45 seconds')
    expect(formatDuration(86_400)).toBe('24 hours')
  })

  it('count down as minutes and seconds, never below zero', () => {
    expect(formatCountdown(581)).toBe('9:41')
    expect(formatCountdown(9)).toBe('0:09')
    expect(formatCountdown(600)).toBe('10:00')
    expect(formatCountdown(-3)).toBe('0:00')
  })
})
