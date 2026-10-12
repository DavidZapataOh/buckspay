import { bytesToHex } from '@noble/hashes/utils.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const payRemainder = vi.fn(async () => ({ status: 'released' as const }))
const receiveRemainder = vi.fn(async () => ({ status: 'released' as const }))
const skipRemainder = vi.fn(async () => undefined)
vi.mock('./remainder', () => ({
  payRemainder: (...args: unknown[]) => payRemainder(...(args as [])),
  receiveRemainder: (...args: unknown[]) => receiveRemainder(...(args as [])),
  skipRemainder: (...args: unknown[]) => skipRemainder(...(args as [])),
}))

const { startRemainder } = await import('./remainder-run')

const tab = (n: number, role: 'debtor' | 'creditor') =>
  ({
    tab: new Uint8Array(32).fill(n),
    peer: 1,
    role,
    remaining: 5n,
    peerKey: new Uint8Array(33),
    state: undefined as never,
  }) as never
const deps = { db: {}, session: new Uint8Array(32).fill(9) } as never
const hex = (n: number) => bytesToHex(new Uint8Array(32).fill(n))

beforeEach(() => {
  payRemainder.mockClear()
  receiveRemainder.mockClear()
  skipRemainder.mockClear()
})

describe('what a phone does with what is left to pay', () => {
  it('a_creditor_waits_for_the_payment_at_once_and_a_debtor_waits_for_the_person', async () => {
    const refresh = vi.fn(async (paying?: ReadonlySet<string>) => void paying)
    const run = startRemainder({ deps, tabs: [tab(1, 'creditor'), tab(2, 'debtor')], refresh, close: vi.fn() })
    await Promise.resolve()
    expect(receiveRemainder).toHaveBeenCalledTimes(1)
    expect(payRemainder).not.toHaveBeenCalled()
    run.stop()
  })

  it('pressing_pay_marks_the_tab_as_paying_while_it_pays_and_reloads_the_rows', async () => {
    const seen: string[][] = []
    const refresh = vi.fn(async (paying: ReadonlySet<string>) => void seen.push([...paying]))
    let finish: () => void = () => undefined
    payRemainder.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve({ status: 'released' as const }))),
    )
    const run = startRemainder({ deps, tabs: [tab(2, 'debtor')], refresh, close: vi.fn() })
    const paying = run.pay(hex(2))
    await Promise.resolve()
    await Promise.resolve()
    expect(seen.at(-1)).toEqual([hex(2)])
    finish()
    await paying
    expect(seen.at(-1)).toEqual([])
    await run.pay(hex(7))
    expect(payRemainder).toHaveBeenCalledTimes(1)
    run.stop()
  })

  it('later_leaves_the_tab_for_another_day', async () => {
    const run = startRemainder({
      deps,
      tabs: [tab(2, 'debtor')],
      refresh: vi.fn(async () => undefined),
      close: vi.fn(),
    })
    await run.later(hex(2))
    expect(skipRemainder).toHaveBeenCalledTimes(1)
    run.stop()
  })

  it('stopping_gives_the_link_back', async () => {
    const close = vi.fn()
    const run = startRemainder({ deps, tabs: [tab(1, 'creditor')], refresh: vi.fn(async () => undefined), close })
    run.stop()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('a_payment_that_fails_leaves_the_rows_to_say_so_instead_of_throwing', async () => {
    payRemainder.mockRejectedValueOnce(new Error('offline'))
    const refresh = vi.fn(async (paying?: ReadonlySet<string>) => void paying)
    const run = startRemainder({ deps, tabs: [tab(2, 'debtor')], refresh, close: vi.fn() })
    await expect(run.pay(hex(2))).resolves.toBeUndefined()
    expect(refresh).toHaveBeenCalled()
    run.stop()
  })
})
