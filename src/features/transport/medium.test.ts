import { describe, expect, it } from 'vitest'
import { mediumOf } from './medium'

const entry = (id: 'qr' | 'nearby') => ({ id })
const entries = [entry('qr'), entry('nearby')]

describe('mediumOf', () => {
  it('takes the one the other phone asked for, whatever this phone remembers', () => {
    expect(mediumOf(entries, entries[0], 'nearby')).toBe(entries[1])
    expect(mediumOf(entries, entries[1], 'qr')).toBe(entries[0])
  })

  it('takes the remembered one when nobody asked, and the first when nothing is known', () => {
    expect(mediumOf(entries, entries[1], undefined)).toBe(entries[1])
    expect(mediumOf(entries, undefined, undefined)).toBe(entries[0])
  })
})
