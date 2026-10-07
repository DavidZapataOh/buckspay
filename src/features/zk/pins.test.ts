import { describe, expect, it, vi } from 'vitest'
import { parsePins } from './pins'

vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { zk: [] } } } }))

const h = (n: string) => n.repeat(64)

describe('parsePins', () => {
  it('reads well-formed hashes', () => {
    const pin = { vkSha256: h('a'), pkSha256: h('b'), ccsSha256: h('c'), dumpSha256: h('d') }
    expect(parsePins([pin])).toEqual([pin])
  })
  it('drops what is malformed instead of trusting it', () => {
    expect(
      parsePins([
        { vkSha256: h('a') },
        null,
        { vkSha256: 'x', pkSha256: h('b'), ccsSha256: h('c'), dumpSha256: h('d') },
      ]),
    ).toEqual([])
    expect(parsePins(undefined)).toEqual([])
    expect(parsePins('aa')).toEqual([])
  })
})
