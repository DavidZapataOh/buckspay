import { describe, expect, it } from 'vitest'
import type { SettlementReport } from './settle-held'
import { whyWaiting } from './why'

const id = new Uint8Array(32).fill(1)
const other = new Uint8Array(32).fill(2)
const report = (over: Partial<SettlementReport>): SettlementReport => ({
  settled: 0,
  waiting: 1,
  failed: 0,
  refused: [],
  stalled: [],
  lost: [],
  notices: [],
  private: [],
  ...over,
})

describe('whyWaiting', () => {
  it('says nothing before a run and nothing about another note', () => {
    expect(whyWaiting(undefined, id)).toBeUndefined()
    expect(whyWaiting(report({ stalled: [{ outputId: other, kind: 'offline' }] }), id)).toBeUndefined()
  })

  it('offers to settle in the clear when the person has not read the notice', () => {
    expect(whyWaiting(report({ notices: [{ outputId: id, holders: 2 }] }), id)).toMatchObject({
      action: 'settle-in-clear',
    })
  })

  it('names what the gateway said, what the phone could not do and what the build lacks', () => {
    const refused = { outputId: id, kind: 'lock', selfPay: false, reason: 'no_lock' }
    expect(whyWaiting(report({ refused: [refused] }), id)?.text).toContain('no_lock')
    expect(whyWaiting(report({ stalled: [{ outputId: id, kind: 'sign' }] }), id)?.text).toContain('Unlock')
    expect(whyWaiting(report({ stalled: [{ outputId: id, kind: 'offline' }] }), id)?.text).toContain('reached')
    expect(whyWaiting(report({ blocked: 'wallet' }), id)?.text).toContain('registered')
    expect(whyWaiting(report({ blocked: 'gateway' }), id)?.text).toContain('no server')
  })

  it('says which limit the server hit, with its code, and that the phone will try again', () => {
    const said = (kind: string, reason: string) =>
      whyWaiting(report({ refused: [{ outputId: id, kind, selfPay: true, reason }] }), id)?.text
    expect(said('busy', 'float_cap')).toBe(
      "The server's settlement budget is used up for now (float_cap). This phone will try again.",
    )
    expect(said('busy', 'lock_share')).toContain('(lock_share)')
    expect(said('busy', 'too_many_locks')).toContain('(too_many_locks)')
    expect(said('busy', 'issuer_locks')).toContain('(issuer_locks)')
    expect(said('busy', 'daily_cap')).toContain('(daily_cap)')
    expect(said('busy', 'unavailable')).toContain('(unavailable)')
    expect(said('busy', 'expired')).toContain('(expired)')
    expect(said('busy', 'paused')).toContain('(paused)')
    expect(said('busy', 'cap')).toContain('(cap)')
    expect(said('busy', 'the gateway is busy')).toBe('The server is busy. This phone will try again. (busy)')
    expect(said('limited', 'network_busy')).toContain('(network_busy)')
    expect(said('limited', 'network_limit')).toContain('(network_limit)')
    expect(said('limited', 'key_limit')).toContain('(key_limit)')
    expect(said('limited', 'lock_limit')).toContain('(lock_limit)')
  })

  it('says which limit was hit and when the server will take the note, together', () => {
    const refused = { outputId: id, kind: 'limited', selfPay: false, reason: 'key_limit', retryAt: 1_800_086_460 }
    const said = whyWaiting(report({ refused: [refused] }), id)?.text
    expect(said).toContain("This payer's settlements for the day or month are used up (key_limit).")
    expect(said).toContain('The server will take this one after')
  })

  it('says the phone asked too often when the request limiter answers in its own words', () => {
    const refused = { outputId: id, kind: 'limited', selfPay: false, reason: 'too many requests' }
    expect(whyWaiting(report({ refused: [refused] }), id)?.text).toBe(
      'This phone asked the server too often (too many requests). This phone will try again.',
    )
  })

  it('keeps the generic sentence, with the code, for a reason it does not know', () => {
    const refused = { outputId: id, kind: 'busy', selfPay: true, reason: 'something_new' }
    expect(whyWaiting(report({ refused: [refused] }), id)?.text).toBe(
      'The server is busy. This phone will try again. (something_new)',
    )
  })

  it('says when it will try again if nothing else is known', () => {
    expect(whyWaiting(report({ retryIn: 30 }), id)?.text).toBe('Trying again in 30 s.')
  })
})
