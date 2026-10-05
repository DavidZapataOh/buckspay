import { describe, expect, it } from 'vitest'
import { formatAmount, parseAmount } from './format-amount'

describe('token amounts', () => {
  it('formats base units without trailing zeros', () => {
    expect(formatAmount(5_000_000n, 6)).toBe('5')
    expect(formatAmount(2_500_000n, 6)).toBe('2.5')
    expect(formatAmount(1n, 6)).toBe('0.000001')
    expect(formatAmount(0n, 6)).toBe('0')
    expect(formatAmount(12n, 0)).toBe('12')
  })

  it('parses what a person types and refuses the rest', () => {
    expect(parseAmount('5', 6)).toBe(5_000_000n)
    expect(parseAmount('2.5', 6)).toBe(2_500_000n)
    expect(parseAmount('0.000001', 6)).toBe(1n)
    expect(parseAmount('.5', 6)).toBeUndefined()
    expect(parseAmount('1.0000001', 6)).toBeUndefined()
    expect(parseAmount('', 6)).toBeUndefined()
    expect(parseAmount('-1', 6)).toBeUndefined()
    expect(parseAmount('1e3', 6)).toBeUndefined()
    expect(parseAmount('1.5', 0)).toBeUndefined()
  })
})
