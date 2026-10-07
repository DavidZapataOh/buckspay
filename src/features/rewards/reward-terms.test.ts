import { beforeEach, describe, expect, it, vi } from 'vitest'
import AsyncStorage, { resetAsyncStorage } from '../../test-support/async-storage'
import { cachedMintTerms, loadMintTerms, saveMintTerms, tipTerms } from './reward-terms'

vi.mock('@react-native-async-storage/async-storage', () => import('../../test-support/async-storage'))

beforeEach(resetAsyncStorage)

const terms = { unit: 490_000n, wordValue: 500_000n }

describe('reward mint terms', () => {
  it('remembers the terms it read', async () => {
    expect(await loadMintTerms()).toBeUndefined()
    await saveMintTerms(terms)
    expect(await loadMintTerms()).toEqual(terms)
  })

  it('ignores a stored value it cannot read', async () => {
    await AsyncStorage.setItem('reward-terms:v1', 'nonsense')
    expect(await loadMintTerms()).toBeUndefined()
  })

  it('answers from the cache without reading the chain, and reads and stores it when there is none', async () => {
    const read = vi.fn(async () => terms)
    expect(await cachedMintTerms(read)).toEqual(terms)
    expect(read).toHaveBeenCalledOnce()
    expect(await cachedMintTerms(read)).toEqual(terms)
    expect(read).toHaveBeenCalledOnce()
  })

  it('lets a failed read reach the caller when nothing is cached', async () => {
    await expect(
      cachedMintTerms(async () => {
        throw new Error('offline')
      }),
    ).rejects.toThrow('offline')
  })
})

describe('tip terms', () => {
  const MIN = 32_000_000n
  it('takes the fee of a word from the mint and the largest bond among the locks', () => {
    expect(tipTerms(terms, [10_000_000n, MIN], true)).toEqual({ wordValue: 500_000n, bond: MIN })
  })

  it('reports a bond of nothing when the phone has no lock, so the screen can say why tipping is off', () => {
    expect(tipTerms(terms, [], true)).toEqual({ wordValue: 500_000n, bond: 0n })
  })

  it('keeps a bond below 32 USDC visible, so tipping is shown off with its reason', () => {
    expect(tipTerms(terms, [MIN - 1n], true)?.bond).toBe(MIN - 1n)
  })

  it('is absent until the mint was read, and without a way to sign a word', () => {
    expect(tipTerms(undefined, [MIN], true)).toBeUndefined()
    expect(tipTerms(terms, [MIN], false)).toBeUndefined()
  })
})
