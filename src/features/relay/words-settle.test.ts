import { describe, expect, it, vi } from 'vitest'
import { runAll } from './words-settle'

describe('runAll', () => {
  it('runs every step in order and returns when all succeed', async () => {
    const order: string[] = []
    await runAll([
      ['a', async () => void order.push('a')],
      ['b', async () => void order.push('b')],
    ])
    expect(order).toEqual(['a', 'b'])
  })

  it('runs the steps after a failure and reports every failure by name', async () => {
    const last = vi.fn(async () => undefined)
    await expect(
      runAll([
        ['words', () => Promise.reject(new Error('The gateway answered 503.'))],
        ['settlement', () => Promise.reject('refused')],
        ['rewards', last],
      ]),
    ).rejects.toThrow('The relay work did not finish. words: The gateway answered 503. settlement: refused')
    expect(last).toHaveBeenCalledOnce()
  })
})
