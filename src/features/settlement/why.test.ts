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

  it('says when it will try again if nothing else is known', () => {
    expect(whyWaiting(report({ retryIn: 30 }), id)?.text).toBe('Trying again in 30 s.')
  })
})
