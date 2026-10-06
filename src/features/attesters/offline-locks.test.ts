import { describe, expect, it } from 'vitest'
import { makeTicket, MINT, party } from '../../payment/testing/world'
import { allowance, needsRefresh, offlineLocks, REFRESH_BEFORE } from './offline-locks'

const device = party(1).key
const NOW = 1_800_000_000
const ticket = (lockSeq: number, over: Partial<Parameters<typeof makeTicket>[0]> = {}) =>
  makeTicket({
    device,
    mint: MINT,
    lockSeq,
    bond: 400n,
    backing: 100n,
    lockUntil: NOW + 30 * 86_400,
    validUntil: NOW + 86_400,
    ...over,
  })

describe('offlineLocks', () => {
  it('joins each active lock with its stored ticket and where its next issue starts', () => {
    const tickets = new Map([
      [3, ticket(3)],
      [4, ticket(4)],
    ])
    const locks = offlineLocks(tickets, [3, 4, 5], new Map([[3, 20n]]))
    expect(locks).toEqual([
      {
        lockSeq: 3,
        mint: MINT,
        bond: 400n,
        backing: 100n,
        lockUntil: NOW + 30 * 86_400,
        ticket: ticket(3),
        nextCumEnd: 20n,
      },
      {
        lockSeq: 4,
        mint: MINT,
        bond: 400n,
        backing: 100n,
        lockUntil: NOW + 30 * 86_400,
        ticket: ticket(4),
        nextCumEnd: 0n,
      },
    ])
  })

  it('leaves out a lock that is no longer active, and a ticket of a lock the chain does not show', () => {
    expect(offlineLocks(new Map([[3, ticket(3)]]), [], new Map())).toEqual([])
  })
})

describe('allowance', () => {
  it('adds what each lock with a ticket the receiver would still believe can back, once its cursor is taken off', () => {
    const locks = offlineLocks(
      new Map([
        [3, ticket(3)],
        [4, ticket(4, { backing: 60n })],
      ]),
      [3, 4],
      new Map([[3, 30n]]),
    )
    expect(allowance(locks, NOW)).toBe(70n + 60n)
  })

  it('leaves out a lock whose ticket ran out or whose lock ends within the note window', () => {
    const stale = ticket(3, { validUntil: NOW - 1 })
    const ending = ticket(4, { lockUntil: NOW + 10 * 86_400 })
    expect(
      allowance(
        offlineLocks(
          new Map([
            [3, stale],
            [4, ending],
          ]),
          [3, 4],
          new Map(),
        ),
        NOW,
      ),
    ).toBe(0n)
  })
})

describe('needsRefresh', () => {
  const locks = (tickets: ReturnType<typeof ticket>[]) =>
    offlineLocks(new Map(tickets.map((t) => [t.lockSeq, t])), [3, 4], new Map())

  it('is true for a lock with no ticket, and when the earliest ticket has less than 12 hours left', () => {
    expect(needsRefresh([3, 4], locks([ticket(3)]), NOW)).toBe(true)
    expect(needsRefresh([3], locks([ticket(3, { validUntil: NOW + REFRESH_BEFORE - 1 })]), NOW)).toBe(true)
  })

  it('is false while every active lock has a ticket with more than 12 hours left, and with no lock at all', () => {
    expect(needsRefresh([3, 4], locks([ticket(3), ticket(4)]), NOW)).toBe(false)
    expect(needsRefresh([], [], NOW)).toBe(false)
  })
})
