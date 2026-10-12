import { afterEach, describe, expect, it } from 'vitest'
import { setLanguage } from '../i18n'
import { formatSol } from './format-sol'

afterEach(() => setLanguage('en'))

describe('formatSol', () => {
  it('writes lamports in SOL to four decimals, rounded down, or up for a cost', () => {
    expect(formatSol(4_600_000n)).toBe('0.0046')
    expect(formatSol(1_099_999n)).toBe('0.001')
    expect(formatSol(1_000_001n, 'up')).toBe('0.0011')
    expect(formatSol(2_000_000_000n)).toBe('2')
  })

  it('writes the decimal mark of the language in use', async () => {
    await setLanguage('es')
    expect(formatSol(4_600_000n)).toBe('0,0046')
    await setLanguage('pt')
    expect(formatSol(4_600_000n)).toBe('0,0046')
    expect(formatSol(12_500_000_000n)).toBe('12,5')
  })
})
