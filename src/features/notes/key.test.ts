import { describe, expect, it, vi } from 'vitest'

vi.mock('expo-secure-store', () => ({}))
vi.mock('expo-sqlite', () => ({}))

const { noteKey } = await import('./key')

const memory = (initial: string | null = null) => {
  let value = initial
  return { get: async () => value, set: async (key: string) => void (value = key), peek: () => value }
}

describe('the key of the note store', () => {
  it('makes 32 random bytes once and reads the same ones afterwards', async () => {
    const storage = memory()
    const first = await noteKey(storage, () => new Uint8Array(32).fill(0xab))
    expect(first).toEqual({ key: 'ab'.repeat(32), created: true })
    expect(await noteKey(storage, () => new Uint8Array(32).fill(1))).toEqual({ key: 'ab'.repeat(32), created: false })
  })

  it('replaces a stored value that is not a key', async () => {
    const storage = memory('nonsense')
    const result = await noteKey(storage, () => new Uint8Array(32).fill(2))
    expect(result).toEqual({ key: '02'.repeat(32), created: true })
    expect(storage.peek()).toBe('02'.repeat(32))
  })
})
