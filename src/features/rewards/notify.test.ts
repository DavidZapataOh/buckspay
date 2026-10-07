import { describe, expect, it, vi } from 'vitest'
import { notifyHeldWord, type Seen } from './notify'

const memory = (): Seen => {
  const ids = new Set<string>()
  return { has: async (id) => ids.has(id), add: async (id) => void ids.add(id) }
}

describe('notifyHeldWord', () => {
  it('notifies once per held word, deep-links to rewards and hides the amount by default', async () => {
    const schedule = vi.fn(async () => {})
    const seen = memory()
    await notifyHeldWord(
      { id: 'a', value: 500_000n },
      { showAmounts: false, symbol: 'USDC', decimals: 6 },
      { schedule, seen },
    )
    await notifyHeldWord(
      { id: 'a', value: 500_000n },
      { showAmounts: false, symbol: 'USDC', decimals: 6 },
      { schedule, seen },
    )
    expect(schedule).toHaveBeenCalledTimes(1)
    expect(schedule).toHaveBeenCalledWith({
      title: 'You earned a fee',
      body: 'A payment you carried was handed in. The fee is paid once the network has it.',
      url: 'buckspay://activity/rewards',
    })
  })

  it('shows the amount only when the person asked for it', async () => {
    const schedule = vi.fn(async () => {})
    await notifyHeldWord(
      { id: 'b', value: 500_000n },
      { showAmounts: true, symbol: 'USDC', decimals: 6 },
      { schedule, seen: memory() },
    )
    expect(schedule.mock.calls[0]).toBeDefined()
    expect(JSON.stringify(schedule.mock.calls[0])).toContain('0.50 USDC')
  })

  it('lets a scheduling failure through and notifies again on the next attempt', async () => {
    const schedule = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined)
    const seen = memory()
    const options = { showAmounts: false, symbol: 'USDC', decimals: 6 }
    await expect(notifyHeldWord({ id: 'c', value: 1n }, options, { schedule, seen })).rejects.toThrow('denied')
    await notifyHeldWord({ id: 'c', value: 1n }, options, { schedule, seen })
    expect(schedule).toHaveBeenCalledTimes(2)
  })
})
