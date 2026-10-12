import { describe, expect, it } from 'vitest'
import { clampBytes } from './clamp-bytes'

describe('clampBytes', () => {
  it('keeps a text that fits', () => {
    expect(clampBytes('Coffee', 48)).toBe('Coffee')
  })

  it('cuts a text at the limit in bytes, not in letters', () => {
    expect(new TextEncoder().encode(clampBytes('a'.repeat(60), 48)).length).toBe(48)
    expect(new TextEncoder().encode(clampBytes('ñ'.repeat(40), 48)).length).toBe(48)
  })

  it('never cuts a letter in half', () => {
    expect(clampBytes('ñ'.repeat(40), 47)).toBe('ñ'.repeat(23))
    expect(clampBytes('café 🙂'.repeat(10), 48)).not.toContain('�')
  })
})
