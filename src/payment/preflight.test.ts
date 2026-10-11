import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import {
  CHALLENGE,
  checkIssueStep,
  Flags,
  GRACE,
  minBond,
  ProtocolError,
  ScopeKind,
  scopeHash,
  verifyPayment,
} from '../protocol'
import { encodeBundle, type PaymentRequest, requestIdOf } from './messages'
import { type OfflineLock, type PayContext, type PayLimits, planPayment } from './preflight'
import { ATTESTER, MINT, makeTicket, NOTE_DOMAIN, party, PROGRAM, receiverFor, signIssue } from './testing/world'

const counterSalt = () => {
  let n = 0
  return () => sha256(Uint8Array.of(7, ++n)).slice(0, 16)
}

const payer = party(1)
const shop = party(2)
const NOW = 1_800_000_000
const OFF_CURVE = (() => {
  for (let fill = 1; fill < 255; fill++) {
    const key = new Uint8Array(33).fill(fill)
    key[0] = 2
    if (!p256.utils.isValidPublicKey(key, true)) return key
  }
  throw new Error('every candidate is on the curve')
})()
const LIMITS: PayLimits = {
  noteLifetime: 72 * 3600,
  noteHops: 3,
  requestTtl: 600,
  skewTolerance: 120,
  transferMargin: 120,
  maxPayment: 100_000_000n,
  biometricFrom: 20_000_000n,
  biometricDaily: 50_000_000n,
}
const MIN_EXPIRY = NOW + LIMITS.requestTtl + LIMITS.transferMargin + 3600

const issueOf = (l: OfflineLock) => ({
  issuer: payer.key,
  mint: l.mint,
  lockSeq: l.lockSeq,
  cumEnd: l.nextCumEnd + 5_000_000n,
  salt: new Uint8Array(16),
  owner: { type: 'device' as const, key: shop.key },
  amount: 5_000_000n,
  caveats: { expiry: NOW + LIMITS.noteLifetime, hopsLeft: 3, flags: 0, scopeKind: 0, scope: new Uint8Array(20) },
})

const request = (over: Partial<PaymentRequest> = {}): PaymentRequest => ({
  owner: { type: 'device', key: shop.key },
  mint: MINT,
  amount: 5_000_000n,
  now: NOW,
  minWindow: 3600,
  minHops: 1,
  attesters: [ATTESTER.id],
  memo: '',
  witness: 'none',
  ...over,
})

function lock(over: Partial<Omit<OfflineLock, 'ticket'>> & { attester?: number } = {}): OfflineLock {
  const { attester, ...fields } = over
  const base = {
    lockSeq: 3,
    mint: MINT,
    bond: 200_000_000n,
    backing: 50_000_000n,
    lockUntil: NOW + 30 * 86400,
    nextCumEnd: 2_000_000n,
    ...fields,
  }
  return {
    ...base,
    ticket: makeTicket({
      device: payer.key,
      mint: base.mint,
      lockSeq: base.lockSeq,
      bond: base.bond,
      backing: base.backing,
      lockUntil: base.lockUntil,
      attester,
    }),
  }
}

const context = (over: Partial<PayContext> = {}): PayContext => ({
  now: NOW + 30,
  me: payer.key,
  locks: [lock()],
  tokens: new Map([[bytesToHex(MINT), { symbol: 'USDC', decimals: 6 }]]),
  limits: LIMITS,
  noteDomain: NOTE_DOMAIN,
  program: PROGRAM,
  salt: counterSalt(),
  knownReceivers: new Set(),
  paidRequests: new Set(),
  paidToday: 0n,
  ...over,
})

describe('planPayment', () => {
  it('builds the issue the payer will sign, from the request and the chosen lock', () => {
    const planned = planPayment(request(), context())
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    const { issue } = planned.plan
    expect(issue.issuer).toEqual(payer.key)
    expect(issue.owner).toEqual({ type: 'device', key: shop.key })
    expect(issue.amount).toBe(5_000_000n)
    expect(issue.lockSeq).toBe(3)
    expect([issue.cumEnd - issue.amount, issue.cumEnd]).toEqual([2_000_000n, 7_000_000n])
    expect(issue.caveats).toEqual({
      expiry: NOW + 72 * 3600,
      hopsLeft: 3,
      flags: 0,
      scopeKind: 0,
      scope: new Uint8Array(20),
    })
    expect(() => checkIssueStep(NOTE_DOMAIN, PROGRAM, issue)).not.toThrow()
  })

  it('shows what the payer must see, taken from the issue and nothing else', () => {
    const planned = planPayment(request({ memo: 'Coffee\n x2' }), context())
    if (!planned.ok) throw new Error('refused')
    expect(planned.plan.review).toEqual({
      amount: planned.plan.issue.amount,
      symbol: 'USDC',
      decimals: 6,
      receiverCode: expect.stringMatching(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/),
      receiverIsNew: true,
      lockSeq: 3,
      allowanceAfter: 50_000_000n - 7_000_000n,
      expiry: planned.plan.issue.caveats.expiry,
      memo: 'Coffee x2',
      biometric: false,
      fee: 0n,
    })
  })

  it('knows a receiver it has paid before, and asks for a biometric from the threshold on', () => {
    const known = context({ knownReceivers: new Set([bytesToHex(shop.key)]) })
    const planned = planPayment(request({ amount: 20_000_000n }), known)
    if (!planned.ok) throw new Error('refused')
    expect(planned.plan.review.receiverIsNew).toBe(false)
    expect(planned.plan.review.biometric).toBe(true)
    const below = planPayment(request({ amount: 19_999_999n }), known)
    expect(below.ok && below.plan.review.biometric).toBe(false)
  })

  it("asks for a biometric when the day's payments reach the daily total, and not one unit before", () => {
    const asked = (paidToday: bigint) => {
      const planned = planPayment(request(), context({ paidToday }))
      return planned.ok && planned.plan.review.biometric
    }
    expect([asked(0n), asked(44_999_999n), asked(45_000_000n)]).toEqual([false, false, true])
  })

  it('raises the hops to what the receiver asks and caps them at 16', () => {
    const hops = (minHops: number) => {
      const planned = planPayment(request({ minHops }), context())
      return planned.ok ? planned.plan.issue.caveats.hopsLeft : null
    }
    expect([hops(1), hops(3), hops(5), hops(16)]).toEqual([3, 3, 5, 16])
  })

  it('uses the lock that ends soonest among those that can pay', () => {
    const planned = planPayment(
      request(),
      context({
        locks: [
          lock({ lockSeq: 1, lockUntil: NOW + 90 * 86400 }),
          lock({ lockSeq: 2, lockUntil: NOW + 40 * 86400 }),
          lock({ lockSeq: 4, lockUntil: NOW + 60 * 86400 }),
        ],
      }),
    )
    expect(planned.ok && planned.plan.lock.lockSeq).toBe(2)
  })

  it('skips a lock that cannot pay and uses another', () => {
    const planned = planPayment(
      request(),
      context({ locks: [lock({ lockSeq: 1, backing: 3_000_000n, nextCumEnd: 0n }), lock({ lockSeq: 2 })] }),
    )
    expect(planned.ok && planned.plan.lock.lockSeq).toBe(2)
  })

  it('caps the note at what the lock can outlast, and refuses a lock too short for the receiver', () => {
    const cap = NOW + 2 * 86400
    const planned = planPayment(request(), context({ locks: [lock({ lockUntil: cap + GRACE + CHALLENGE })] }))
    expect(planned.ok && planned.plan.issue.caveats.expiry).toBe(cap - 1)
    const short = planPayment(request(), context({ locks: [lock({ lockUntil: MIN_EXPIRY - 1 + GRACE + CHALLENGE })] }))
    expect(short).toEqual({ ok: false, reason: 'LockTooShort', lockSeq: 3 })
    const exact = planPayment(request(), context({ locks: [lock({ lockUntil: MIN_EXPIRY + 1 + GRACE + CHALLENGE })] }))
    expect(exact.ok).toBe(true)
  })

  describe('refusals, in the order they are checked', () => {
    it.each([
      ['an unknown mint', () => planPayment(request({ mint: new Uint8Array(32).fill(1) }), context()), 'UnknownMint'],
      [
        'a request for its own key',
        () => planPayment(request({ owner: { type: 'device', key: payer.key } }), context()),
        'SelfPayment',
      ],
      [
        'a receiver key that is not on the curve',
        () => planPayment(request({ owner: { type: 'device', key: OFF_CURVE } }), context()),
        'Malformed',
      ],
      [
        'an amount above its own limit',
        () => planPayment(request({ amount: 100_000_001n }), context()),
        'AboveYourLimit',
      ],
      [
        'a request from the future',
        () => planPayment(request({ now: NOW + 151 }), context({ now: NOW + 30 })),
        'ClockOrExpired',
      ],
      [
        'a request older than its time to live',
        () => planPayment(request(), context({ now: NOW + 600 + 121 })),
        'ClockOrExpired',
      ],
      [
        'no lock for the mint',
        () => planPayment(request(), context({ locks: [lock({ mint: new Uint8Array(32).fill(8) })] })),
        'NoLock',
      ],
      ['no lock at all', () => planPayment(request(), context({ locks: [] })), 'NoLock'],
      [
        'a request it already has a live payment for',
        () => planPayment(request(), context({ paidRequests: new Set([bytesToHex(requestIdOf(request()))]) })),
        'AlreadyPaid',
      ],
      [
        'an attester the receiver does not trust',
        () => planPayment(request({ attesters: [99] }), context()),
        'AttesterNotTrusted',
      ],
      [
        'a bond below the amount',
        () => planPayment(request(), context({ locks: [lock({ bond: 4_999_999n })] })),
        'BondTooSmall',
      ],
      [
        'an allowance below the amount',
        () => planPayment(request(), context({ locks: [lock({ backing: 6_999_999n })] })),
        'AllowanceTooLow',
      ],
    ])('%s', (_, run, reason) => {
      expect(run()).toMatchObject({ ok: false, reason })
    })

    it('accepts a request that is exactly fresh and exactly early enough', () => {
      expect(planPayment(request({ now: NOW + 150 }), context({ now: NOW + 30 })).ok).toBe(true)
      expect(planPayment(request(), context({ now: NOW + 600 + 120 })).ok).toBe(true)
      expect(planPayment(request(), context({ locks: [lock({ bond: 20_000_000n, backing: 7_000_000n })] })).ok).toBe(
        true,
      )
    })

    it('explains a refusal with the lock that came closest', () => {
      const planned = planPayment(
        request(),
        context({
          locks: [
            lock({ lockSeq: 1, backing: 1n, nextCumEnd: 0n }),
            lock({ lockSeq: 2, lockUntil: MIN_EXPIRY - 1 + GRACE + CHALLENGE }),
          ],
        }),
      )
      expect(planned).toEqual({ ok: false, reason: 'LockTooShort', lockSeq: 2 })
    })
  })
})

describe('what the payer checks is what the receiver checks', () => {
  /** Signs what a payer would and runs the receiver's `verifyPayment` at the latest moment it can arrive. */
  function receiverAccepts(req: PaymentRequest, l: OfflineLock): boolean {
    const planned = planPayment(req, context({ locks: [l] }))
    const cap = l.lockUntil - GRACE - CHALLENGE
    const issue = planned.ok
      ? planned.plan.issue
      : {
          issuer: payer.key,
          mint: req.mint,
          lockSeq: l.lockSeq,
          cumEnd: l.nextCumEnd + req.amount,
          salt: new Uint8Array(16).fill(7),
          owner: req.owner,
          amount: req.amount,
          caveats: {
            expiry: Math.min(req.now + LIMITS.noteLifetime, cap),
            hopsLeft: 3,
            flags: 0,
            scopeKind: 0,
            scope: new Uint8Array(20),
          },
        }
    const signed = signIssue(payer, issue)
    const arrival = req.now + LIMITS.requestTtl + LIMITS.transferMargin
    try {
      verifyPayment(
        receiverFor(shop, {
          now: arrival,
          minWindow: req.minWindow,
          attesters: req.attesters.includes(ATTESTER.id) ? [ATTESTER] : [],
        }),
        signed,
        [],
        [l.ticket],
      )
      return true
    } catch (error) {
      if (error instanceof ProtocolError) return false
      throw error
    }
  }

  it('plans a payment exactly when verifyPayment would accept it, over every combination of the edges', () => {
    const amount = 5_000_000n
    let ok = 0
    let refused = 0
    const least = minBond(amount)!
    for (const bond of [least - 1n, least, least + 1n])
      for (const allowance of [amount - 1n, amount, amount + 1n])
        for (const cap of [MIN_EXPIRY - 1, MIN_EXPIRY, MIN_EXPIRY + 1, NOW + 365 * 86400])
          for (const trusted of [true, false])
            for (const sameMint of [true, false]) {
              const l = lock({
                bond,
                backing: 2_000_000n + allowance,
                lockUntil: cap + GRACE + CHALLENGE,
                mint: sameMint ? MINT : new Uint8Array(32).fill(8),
              })
              const req = request({ attesters: trusted ? [ATTESTER.id] : [99] })
              const planned = planPayment(req, context({ locks: [l] })).ok
              const accepted = receiverAccepts(req, l)
              expect({ bond, allowance, cap, trusted, sameMint, planned }).toEqual({
                bond,
                allowance,
                cap,
                trusted,
                sameMint,
                planned: accepted,
              })
              if (planned) ok++
              else refused++
            }
    expect(ok).toBeGreaterThan(0)
    expect(refused).toBeGreaterThan(0)
  })

  it('plans exactly when the receiver would still believe the ticket at the last moment the payment can arrive', () => {
    const arrival = NOW + LIMITS.requestTtl + LIMITS.transferMargin
    for (const validUntil of [arrival - 1, arrival, arrival + 1]) {
      const l = lock()
      const ticket = makeTicket({
        device: payer.key,
        mint: l.mint,
        lockSeq: l.lockSeq,
        bond: l.bond,
        backing: l.backing,
        lockUntil: l.lockUntil,
        validUntil,
      })
      const stale = { ...l, ticket }
      const planned = planPayment(request(), context({ locks: [stale] }))
      const signed = signIssue(payer, planned.ok ? planned.plan.issue : issueOf(stale))
      const accepts = (() => {
        try {
          verifyPayment(receiverFor(shop, { now: arrival, attesters: [ATTESTER] }), signed, [], [ticket])
          return true
        } catch {
          return false
        }
      })()
      expect({ validUntil, planned: planned.ok }).toEqual({ validUntil, planned: accepts })
      if (!planned.ok) expect(planned.reason).toBe('TicketStale')
    }
  })

  it('produces a bundle the receiver accepts, whatever hops, minimum window and amount are asked', () => {
    for (const [minHops, minWindow, amount] of [
      [1, 0, 1n],
      [2, 3600, 5_000_000n],
      [16, 86_400, 99_999_999n],
    ] as const) {
      const req = request({ minHops, minWindow, amount })
      const l = lock({ backing: 400_000_000n, bond: 400_000_000n })
      const planned = planPayment(req, context({ locks: [l] }))
      if (!planned.ok) throw new Error(planned.reason)
      const signed = signIssue(payer, planned.plan.issue)
      const wire = encodeBundle({ issue: signed, spends: [], tickets: [l.ticket] })
      expect(wire).toHaveLength(391)
      expect(() =>
        verifyPayment(receiverFor(shop, { now: NOW + 720, minWindow }), signed, [], [l.ticket]),
      ).not.toThrow()
    }
  })
})

describe('planPayment of event credit', () => {
  const authority = new Uint8Array(32).fill(0xa0)

  it('sets the flag and the scope of the authority', () => {
    const planned = planPayment(request(), context(), { authorityOnly: authority })
    if (!planned.ok) throw new Error(planned.reason)
    const { caveats } = planned.plan.issue
    expect(caveats.flags).toBe(Flags.AuthorityOnly)
    expect(caveats.scopeKind).toBe(ScopeKind.Authority)
    expect(caveats.scope).toEqual(scopeHash({ type: 'account', address: authority }))
  })

  it('refuses a request whose owner is an account: credit is sold to people', () => {
    const owner = { type: 'account', address: new Uint8Array(32).fill(5) } as const
    expect(planPayment(request({ owner }), context(), { authorityOnly: authority })).toMatchObject({
      ok: false,
      reason: 'Malformed',
    })
  })

  it('leaves an ordinary payment unscoped', () => {
    const planned = planPayment(request(), context())
    if (!planned.ok) throw new Error(planned.reason)
    expect(planned.plan.issue.caveats).toMatchObject({ flags: 0, scopeKind: ScopeKind.Any })
  })
})
