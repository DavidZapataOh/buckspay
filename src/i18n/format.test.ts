import { beforeEach, describe, expect, it } from 'vitest'
import { setLanguage } from './index'
import {
  formatAmount,
  formatCountdown,
  formatDate,
  formatDateTime,
  formatDuration,
  formatMoney,
  parseAmount,
} from './format'

describe('formatAmount', () => {
  it('is the decimal string of the base units, without separators, always with a point', () => {
    expect(formatAmount(5_000_000n, 6)).toBe('5')
    expect(formatAmount(1_500_000n, 6)).toBe('1.5')
    expect(formatAmount(1_234_567n, 6)).toBe('1.234567')
    expect(formatAmount(1n, 6)).toBe('0.000001')
  })
})

describe('formatMoney', () => {
  it('writes at least two decimals, with the separators of each language', () => {
    expect(formatMoney(5_000_000n, 6, 'en')).toBe('5.00')
    expect(formatMoney(5_000_000n, 6, 'es')).toBe('5,00')
    expect(formatMoney(5_000_000n, 6, 'pt')).toBe('5,00')
    expect(formatMoney(50_000n, 6, 'es')).toBe('0,05')
  })

  it('groups the thousands', () => {
    expect(formatMoney(1_234_500_000n, 6, 'en')).toBe('1,234.50')
    expect(formatMoney(1_234_500_000n, 6, 'es')).toBe('1.234,50')
    expect(formatMoney(1_234_500_000n, 6, 'pt')).toBe('1.234,50')
    expect(formatMoney(999_999_999_999_999_999n, 6, 'en')).toBe('999,999,999,999.999999')
  })

  it('shows more decimals only when the amount needs them, and never loses a unit', () => {
    expect(formatMoney(1_234_567n, 6, 'es')).toBe('1,234567')
    expect(formatMoney(1n, 6, 'en')).toBe('0.000001')
  })

  it('works with a token that has no decimals', () => {
    expect(formatMoney(7n, 0, 'es')).toBe('7')
  })
})

describe('parseAmount', () => {
  it('reads a decimal written with a point or a comma', () => {
    expect(parseAmount('5', 6)).toBe(5_000_000n)
    expect(parseAmount('0.05', 6)).toBe(50_000n)
    expect(parseAmount('0,05', 6)).toBe(50_000n)
    expect(parseAmount(' 1,5 ', 6)).toBe(1_500_000n)
  })

  it('refuses more decimals than the token holds', () => {
    expect(parseAmount('0,0000001', 6)).toBeUndefined()
    expect(parseAmount('1.5', 0)).toBeUndefined()
  })

  it('refuses anything that is not a plain amount, and a number with two kinds of separator', () => {
    for (const bad of ['', ' ', 'abc', '1,2,3', '1.2.3', '-1', '1e3', '.5', ',5', '12.', '1.000,50', '1,000.50']) {
      expect(parseAmount(bad, 6), bad).toBeUndefined()
    }
  })

  it('refuses a separator that could be a thousands mark, because it would read as one in one language and as a decimal in another', () => {
    for (const ambiguous of ['1.000', '1,000', '12.500', '12,500', '999.999']) {
      expect(parseAmount(ambiguous, 6), ambiguous).toBeUndefined()
    }
  })

  it('accepts three decimals when the whole part is zero or has more than three digits', () => {
    expect(parseAmount('0.125', 6)).toBe(125_000n)
    expect(parseAmount('0,125', 6)).toBe(125_000n)
    expect(parseAmount('1234.567', 6)).toBe(1_234_567_000n)
  })
})

describe('what the old helpers already guaranteed', () => {
  it('keeps its edge cases', () => {
    expect(formatAmount(0n, 6)).toBe('0')
    expect(formatAmount(12n, 0)).toBe('12')
    expect(formatMoney(0n, 6, 'en')).toBe('0.00')
    expect(formatMoney(5n, 1, 'en')).toBe('0.5')
    expect(parseAmount('0.000001', 6)).toBe(1n)
    expect(parseAmount('1.0000001', 6)).toBeUndefined()
  })
})

describe('dates', () => {
  it('follow the language, not the phone', () => {
    const at = 1_800_000_000
    const options = {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC',
    } as const
    expect(formatDateTime(at, 'es', 'UTC')).toBe(new Intl.DateTimeFormat('es-CO', options).format(new Date(at * 1000)))
    expect(formatDateTime(at, 'pt', 'UTC')).toBe(new Intl.DateTimeFormat('pt-BR', options).format(new Date(at * 1000)))
    expect(formatDateTime(at, 'es', 'UTC')).not.toBe(formatDateTime(at, 'en', 'UTC'))
    expect(formatDate(at, 'en', 'UTC')).toBe(
      new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
        new Date(at * 1000),
      ),
    )
    for (const language of ['en', 'es', 'pt'] as const) {
      expect(formatDate(at, language, 'UTC'), language).toMatch(/\p{L}{3,}/u)
      expect(formatDate(at, language, 'UTC'), language).not.toContain('/')
    }
  })
})

describe('formatCountdown', () => {
  it('is m:ss in every language', () => {
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(59)).toBe('0:59')
    expect(formatCountdown(600)).toBe('10:00')
    expect(formatCountdown(-5)).toBe('0:00')
  })
})

describe('formatDuration', () => {
  const cases: [Parameters<typeof setLanguage>[0], number, string][] = [
    ['en', 3600, '1 hour'],
    ['en', 5400, '1 hour 30 minutes'],
    ['en', 600, '10 minutes'],
    ['en', 45, '45 seconds'],
    ['en', 1, '1 second'],
    ['es', 3600, '1 hora'],
    ['es', 5400, '1 hora 30 minutos'],
    ['es', 600, '10 minutos'],
    ['es', 1, '1 segundo'],
    ['pt', 7200, '2 horas'],
    ['pt', 600, '10 minutos'],
    ['pt', 45, '45 segundos'],
  ]
  for (const [language, seconds, expected] of cases) {
    it(`says ${seconds} s in ${language} as "${expected}"`, async () => {
      await setLanguage(language)
      expect(formatDuration(seconds)).toBe(expected)
    })
  }
  beforeEach(async () => {
    await setLanguage('en')
  })
})
