import { describe, expect, it } from 'vitest'
import { resolveProfile } from '../../protocol/profile'
import {
  balanceNotice,
  gatewayLabel,
  payeeObligation,
  reclaimLabel,
  reclaimWindowNotice,
  refusalNotice,
  settlementLabel,
} from './settlement-copy'

const { windows } = resolveProfile({})

describe('what the user is told about settling and reclaiming', () => {
  it('labels what each clear-text action publishes, and who sees it', () => {
    expect(settlementLabel).toContain(
      'publishes the keys of the people it passed through, every amount, and the account that is paid',
    )
    expect(reclaimLabel).toContain('publishes the whole chain it passed through')
    expect(reclaimLabel).toContain('even if the payment would otherwise have settled privately')
    expect(gatewayLabel).toContain('sees this chain, your network address and the time')
  })

  it('tells the payee until when it must settle', () => {
    const expiry = Date.UTC(2030, 0, 10) / 1000
    expect(payeeObligation(expiry, windows)).toContain('before 2030-01-17 (UTC)')
    expect(payeeObligation(expiry, windows)).toContain('not covered by their bond')
  })

  it('says how long an unsettled payment can be taken back, and who cannot', () => {
    expect(reclaimWindowNotice(windows)).toContain('14 days')
    expect(reclaimWindowNotice(windows)).toContain('no registered device')
    const short = resolveProfile({ profile: 'short' }).windows
    expect(reclaimWindowNotice(short)).toContain('2 minutes')
  })

  it('answers each refusal in words, and offers to pay when the sponsor cannot', () => {
    expect(refusalNotice('conflict')).toContain('evidence')
    expect(refusalNotice('horizon', Date.UTC(2030, 5, 1) / 1000)).toContain('2030-06-01')
    expect(refusalNotice('below_minimum')).toContain('pay for it yourself')
    expect(refusalNotice('busy')).toContain('pay for it yourself')
    expect(refusalNotice('horizon')).not.toContain('undefined')
    expect(balanceNotice).toContain('every account')
  })
})
