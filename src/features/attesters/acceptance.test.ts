import { describe, expect, it } from 'vitest'

import { type Attester, MAX_NOTE_LIFE, MAX_REGISTRY_AGE, paymentLimit } from '../../protocol'
import { acceptancePolicy, AttesterLedger } from './acceptance'
import { buildAttester, type RegistryRead, type TrustedAttester } from './registry'

const bytes = (n: number) => new Uint8Array(32).fill(n)
const NOW = 1_900_000_000
const trusted: TrustedAttester = { id: 1, authority: bytes(1), mint: bytes(2) }
const read: RegistryRead = {
  authority: bytes(1),
  mint: bytes(2),
  key: bytes(3),
  prevKey: bytes(0),
  prevTrustedUntil: 0,
  status: 1,
  bondFree: 1_000_000n,
}

describe('the attester a wallet believes', () => {
  it('is built from the registry when both providers agree and the authority is the pinned one', () => {
    const attester = buildAttester(trusted, read, read, NOW)
    expect(attester).toMatchObject({ id: 1, stake: 1_000_000n, active: true, syncedAt: NOW, relied: 0n })
    expect(attester?.key).toEqual(bytes(3))
  })

  it('is dropped when the providers disagree on a key, a status or a stake', () => {
    for (const other of [{ key: bytes(4) }, { prevKey: bytes(5) }, { status: 2 }, { bondFree: 5n }]) {
      expect(buildAttester(trusted, read, { ...read, ...other }, NOW)).toBeUndefined()
    }
  })

  it('is dropped when its authority or mint is not the one that was pinned', () => {
    expect(
      buildAttester(trusted, { ...read, authority: bytes(9) }, { ...read, authority: bytes(9) }, NOW),
    ).toBeUndefined()
    expect(buildAttester(trusted, { ...read, mint: bytes(9) }, { ...read, mint: bytes(9) }, NOW)).toBeUndefined()
  })

  it('is inactive unless the registry says Active, and keeps what a wallet relied on and revoked', () => {
    const previous = {
      ...buildAttester(trusted, read, read, NOW)!,
      relied: 7n,
      revoked: [bytes(8), bytes(0)] as Attester['revoked'],
    }
    const synced = buildAttester(trusted, { ...read, status: 2 }, { ...read, status: 2 }, NOW + 5, previous)!
    expect(synced.active).toBe(false)
    expect(synced.relied).toBe(7n)
    expect(synced.revoked[0]).toEqual(bytes(8))
  })
})

describe('the receiver a wallet builds', () => {
  const attester = buildAttester(trusted, read, read, NOW)!
  const options = {
    noteDomain: bytes(10),
    ticketDomain: bytes(11),
    program: bytes(12),
    me: { type: 'device', key: Uint8Array.of(2, ...bytes(13)) } as const,
    now: NOW,
    attesters: [attester],
  }

  it('refuses a note longer than the default note life and a registry older than a week', () => {
    const receiver = acceptancePolicy(options)
    expect(receiver.maxNoteLife).toBe(MAX_NOTE_LIFE)
    expect(receiver.minWindow).toBeGreaterThan(0)
    expect(receiver.attesters).toEqual([attester])
    expect(MAX_NOTE_LIFE).toBe(72 * 3600)
    expect(MAX_REGISTRY_AGE).toBe(7 * 86_400)
  })

  it('requires a day of validity unless the wallet asks for less', () => {
    expect(acceptancePolicy(options).minWindow).toBe(86_400)
    expect(acceptancePolicy({ ...options, minWindow: 3_600 }).minWindow).toBe(3_600)
    expect(() => acceptancePolicy({ ...options, minWindow: -1 })).toThrow()
  })

  it('lets a wallet choose a shorter note life and never a longer one', () => {
    expect(acceptancePolicy({ ...options, maxNoteLife: 3_600 }).maxNoteLife).toBe(3_600)
    expect(() => acceptancePolicy({ ...options, maxNoteLife: MAX_NOTE_LIFE + 1 })).toThrow()
  })
})

describe('what a wallet relies on each attester for', () => {
  const liable = (attester: number) => ({ device: bytes(1), lockSeq: 0, bond: 4n, attester })

  it('counts the amount of every accepted payment once per attester that vouched', () => {
    const ledger = new AttesterLedger()
    ledger.accepted(100n, [liable(1), liable(1), liable(2)])
    expect(ledger.relied(1)).toBe(100n)
    expect(ledger.relied(2)).toBe(100n)
    expect(ledger.relied(3)).toBe(0n)
  })

  it('releases what settled and never goes below zero', () => {
    const ledger = new AttesterLedger()
    ledger.accepted(100n, [liable(1)])
    ledger.settled(40n, [liable(1)])
    expect(ledger.relied(1)).toBe(60n)
    ledger.settled(500n, [liable(1)])
    expect(ledger.relied(1)).toBe(0n)
  })

  it('survives a restart as plain data and feeds the attesters the receiver is built from', () => {
    const ledger = new AttesterLedger()
    ledger.accepted(100n, [liable(1)])
    const restored = AttesterLedger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())))
    expect(restored.relied(1)).toBe(100n)
    const attester = buildAttester(trusted, read, read, NOW)!
    expect(restored.apply([attester])[0].relied).toBe(100n)
  })

  it('stops a thousand phantom payments of a quarter of the stake at the first', () => {
    const attester = buildAttester(trusted, read, read, NOW)!
    const quarter = paymentLimit(attester.stake)
    const ledger = new AttesterLedger()
    let accepted = 0
    for (let i = 0; i < 1_000; i++) {
      const [current] = ledger.apply([attester])
      if (current.relied + quarter <= paymentLimit(current.stake)) {
        ledger.accepted(quarter, [liable(1)])
        accepted++
      }
    }
    expect(accepted).toBe(1)
  })
})
