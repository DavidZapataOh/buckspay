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
    expect(whyWaiting(report({ refused: [refused] }), id)?.code).toBe('no_lock')
    expect(whyWaiting(report({ stalled: [{ outputId: id, kind: 'sign' }] }), id)?.text).toContain('Unlock')
    expect(whyWaiting(report({ stalled: [{ outputId: id, kind: 'offline' }] }), id)?.text).toContain('reached')
    expect(whyWaiting(report({ blocked: 'wallet' }), id)?.text).toContain('registered')
    expect(whyWaiting(report({ blocked: 'gateway' }), id)?.text).toContain('no server')
  })

  it('says which limit the server hit, keeps its code apart and that the phone will try again', () => {
    const whyOf = (kind: string, reason: string) =>
      whyWaiting(report({ refused: [{ outputId: id, kind, selfPay: true, reason }] }), id)
    const said = (kind: string, reason: string) => whyOf(kind, reason)?.text
    expect(said('busy', 'float_cap')).toBe(
      'The server has reached its limit of payments it can credit for now. This phone will try again.',
    )
    expect(whyOf('busy', 'lock_share')?.code).toBe('lock_share')
    expect(whyOf('busy', 'too_many_locks')?.code).toBe('too_many_locks')
    expect(whyOf('busy', 'issuer_locks')?.code).toBe('issuer_locks')
    expect(whyOf('busy', 'daily_cap')?.code).toBe('daily_cap')
    expect(whyOf('busy', 'unavailable')?.code).toBe('unavailable')
    expect(whyOf('busy', 'expired')?.code).toBe('expired')
    expect(whyOf('busy', 'paused')?.code).toBe('paused')
    expect(whyOf('busy', 'cap')?.code).toBe('cap')
    expect(said('busy', 'the gateway is busy')).toBe('The server is busy. This phone will try again.')
    expect(whyOf('busy', 'the gateway is busy')?.code).toBe('busy')
    expect(whyOf('limited', 'network_busy')?.code).toBe('network_busy')
    expect(whyOf('limited', 'network_limit')?.code).toBe('network_limit')
    expect(whyOf('limited', 'key_limit')?.code).toBe('key_limit')
    expect(whyOf('limited', 'lock_limit')?.code).toBe('lock_limit')
  })

  it('says which limit was hit and when the server will take the note, together', () => {
    const refused = { outputId: id, kind: 'limited', selfPay: false, reason: 'key_limit', retryAt: 1_800_086_460 }
    const said = whyWaiting(report({ refused: [refused] }), id)?.text
    expect(said).toContain('This payer has reached the limit of payments that can be credited for the day or month.')
    expect(said).toContain('The server will take this one after')
  })

  it('says the phone asked too often when the request limiter answers in its own words', () => {
    const refused = { outputId: id, kind: 'limited', selfPay: false, reason: 'too many requests' }
    const why = whyWaiting(report({ refused: [refused] }), id)
    expect(why?.text).toBe('This phone asked the server too often. This phone will try again.')
    expect(why?.code).toBe('too many requests')
  })

  it('keeps the generic sentence, and the code apart, for a reason it does not know', () => {
    const refused = { outputId: id, kind: 'busy', selfPay: true, reason: 'something_new' }
    const why = whyWaiting(report({ refused: [refused] }), id)
    expect(why?.text).toBe('The server is busy. This phone will try again.')
    expect(why?.code).toBe('something_new')
  })

  it('says when it will try again if nothing else is known', () => {
    expect(whyWaiting(report({ retryIn: 30 }), id)?.text).toBe('Trying again in 30 s.')
  })
})
