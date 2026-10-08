import { describe, expect, it, vi } from 'vitest'
import { IouCause } from '../../protocol'
import { byLabel, mount, press, texts, type as typeInto } from '../remote/ui-testing'
import { AcceptScreen } from './accept-screen'
import { debtsCopy } from './copy'
import { DebtsScreen } from './debts-screen'
import { peerLabel, recordCode, summarize, type TabSummary } from './format'
import { NewDebtScreen } from './new-debt-screen'
import { TabScreen } from './tab-screen'
import { coSigned, iouOf, MINT, party, SECRET, TAB } from './testing'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (n: string | string[]) => (Array.isArray(n) ? n.map(() => '#000000') : '#000000'),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))

const [ana, ben] = [party(0xa1), party(0xb1)]
const money = { symbol: 'USDC', decimals: 6 }
const BANNED = [
  /private payment/i,
  /anonymous/i,
  /nobody can see/i,
  /guaranteed/i,
  /bounded loss/i,
  /buckspay collects/i,
  /credit line/i,
  /\bearn/i,
  /final for everyone/i,
  /t[ií]tulo/i,
]
const row = {
  tab: TAB,
  secret: SECRET,
  peer: ben.key,
  mint: MINT,
  finalSeq: 3,
  nextSeq: 4,
  lockedBy: null,
  createdAt: 1,
}
const latest = coSigned(iouOf(3, ben.key, ana.key, 25_000_000n), ben, ana)
const states = [latest]
const summary = (extra: Partial<TabSummary> = {}): TabSummary => ({
  ...summarize(ana.key, row, states, null, [], []),
  ...extra,
})
const tabProps = {
  history: [],
  nettings: [],
  me: ana.key,
  ...money,
  busy: false,
  onChange: vi.fn(),
  onRepay: vi.fn(),
  onResend: vi.fn(),
}
const shown = (r: Awaited<ReturnType<typeof mount>>) => texts(r.root).join('\n')

describe('debt screens', () => {
  it('summarizes a tab from this phone’s side', () => {
    const s = summarize(ana.key, row, states, null, [], [])
    expect(s).toMatchObject({
      direction: 'owed',
      amount: 25_000_000n,
      seq: 3,
      waiting: false,
      locked: false,
      orphaned: false,
      settling: false,
      settlingAmount: 0n,
    })
    expect(summarize(ben.key, { ...row, peer: ana.key }, states, null, [], []).direction).toBe('owe')
    expect(summarize(party(0xc1).key, row, states, null, [], []).orphaned).toBe(true)
    expect(s.recordCode).toBe(recordCode(states))
    expect(recordCode(states)).toMatch(/^[0-9a-f]{4} [0-9a-f]{4}$/)
    const more = coSigned(iouOf(4, ben.key, ana.key, 1n), ben, ana)
    expect(recordCode([latest, more])).not.toBe(recordCode(states))
    const netted = summarize(
      ana.key,
      row,
      states,
      null,
      [{ content: new Uint8Array(32).fill(1), tab: TAB, baseSeq: 3, debtor: ben.key, cancel: 5_000_000n }],
      [],
    )
    expect(netted.amount).toBe(20_000_000n)
    expect(peerLabel(ben.key)).toMatch(/^Friend [0-9a-f]{6}$/)
  })

  it('the list says who owes whom, and each state note', async () => {
    const tabs = [
      summary(),
      summary({ direction: 'owe', amount: 5_000_000n, peerLabel: 'Friend aaaaaa', waiting: true }),
      summary({ direction: 'settled', amount: 0n, peerLabel: 'Friend bbbbbb', locked: true }),
      summary({ peerLabel: 'Friend cccccc', orphaned: true }),
    ]
    const r = await mount(<DebtsScreen tabs={tabs} {...money} onOpen={vi.fn()} onNew={vi.fn()} />)
    const all = shown(r)
    expect(all).toContain(debtsCopy.intro)
    expect(all).toContain(`${peerLabel(ben.key)} owes you 25.00 USDC`)
    expect(all).toContain('You owe Friend aaaaaa 5.00 USDC')
    expect(all).toContain('Waiting for Friend aaaaaa to sign')
    expect(all).toContain('Settled up with Friend bbbbbb')
    expect(all).toContain('In a netting session')
    expect(all).toContain(debtsCopy.orphaned)
    for (const banned of BANNED) expect(all).not.toMatch(banned)
  })

  it('the tab shows paid, settling, a recorded netting, the record code and the history of changes', async () => {
    const reference = new Uint8Array(32).fill(9)
    const repay = coSigned(iouOf(4, ben.key, ana.key, 5_000_000n, { cause: IouCause.Repay, reference }), ben, ana)
    const settling = [
      { tab: TAB, seq: 4, reference, payee: ana.key, reduction: 5_000_000n, status: 'settling' as const },
    ]
    const s = summarize(ana.key, { ...row, finalSeq: 4 }, [latest, repay], null, [], settling)
    expect(s).toMatchObject({ amount: 20_000_000n, settling: true, settlingAmount: 5_000_000n, pending: true })
    const history = [repay, latest].map((x) => ({
      iou: x.iou,
      debtorSig: x.debtorSig,
      creditorSig: x.creditorSig,
      memo: null,
      recordedAt: 1,
    }))
    const r = await mount(
      <TabScreen
        {...tabProps}
        summary={s}
        history={history}
        nettings={[{ cancel: 2_000_000n, recordedAt: 1_900_000_000 }]}
      />,
    )
    const all = shown(r)
    expect(all).toContain('Paid 5.00 USDC, settling')
    expect(all).toContain(debtsCopy.settlingDetail)
    expect(all).toContain('2.00 USDC cancelled in a netting, recorded')
    expect(all).toContain(`Record code ${recordCode([latest, repay])}`)
    expect(all).toMatch(/#4 .*#3 /s)
  })

  it('clear is disabled with its reason while pending, and only a debtor can pay with Buckspay', async () => {
    const pending = await mount(<TabScreen {...tabProps} summary={summary({ pending: true })} />)
    expect(shown(pending)).toContain(debtsCopy.clearPending)
    expect(byLabel(pending.root, 'Clear this debt').props.accessibilityState).toMatchObject({ disabled: true })
    expect(byLabel(pending.root, 'Pay with Buckspay')).toBeUndefined()
    const onRepay = vi.fn()
    const owing = await mount(<TabScreen {...tabProps} summary={summary({ direction: 'owe' })} onRepay={onRepay} />)
    expect(shown(owing)).toContain(debtsCopy.repayNote)
    await press(owing.root, 'Pay with Buckspay')
    expect(onRepay).toHaveBeenCalledTimes(1)
    expect(byLabel(owing.root, 'Clear this debt').props.accessibilityState).toMatchObject({ disabled: false })
  })

  it('a pending offer can be sent again, and says it stays valid', async () => {
    const onResend = vi.fn()
    const r = await mount(<TabScreen {...tabProps} summary={summary({ waiting: true })} onResend={onResend} />)
    expect(shown(r)).toContain(debtsCopy.stillValid)
    await press(r.root, 'Send again')
    expect(onResend).toHaveBeenCalledTimes(1)
  })

  it('new debt asks for an amount and sends the intent', async () => {
    const onSubmit = vi.fn()
    const r = await mount(
      <NewDebtScreen {...money} peerLabel={null} viaCode busy={false} error={null} onSubmit={onSubmit} />,
    )
    expect(shown(r)).toContain(debtsCopy.viaCode)
    await press(r.root, 'Send to sign')
    expect(shown(r)).toContain('Enter an amount')
    expect(onSubmit).not.toHaveBeenCalled()
    await press(r.root, 'I lent')
    await typeInto(r.root, 'Amount', '25')
    await typeInto(r.root, 'What for (optional)', 'Dinner')
    await press(r.root, 'Send to sign')
    expect(onSubmit).toHaveBeenCalledWith({ kind: 'lent', amount: 25_000_000n, due: 0, memo: 'Dinner' })
  })

  it('accept shows before and after, the due date and both choices', async () => {
    const next = iouOf(4, ben.key, ana.key, 30_000_000n, { due: 1_900_000_000 })
    const [onSign, onDecline] = [vi.fn(), vi.fn()]
    const view = { state: next, previous: latest, balance: 25_000_000n, memo: 'Taxi', first: false }
    const r = await mount(
      <AcceptScreen
        view={view}
        me={ana.key}
        peerLabel="Friend aaaaaa"
        {...money}
        viaCode={false}
        busy={false}
        onSign={onSign}
        onDecline={onDecline}
      />,
    )
    const all = shown(r)
    expect(all).toContain('Before: Friend aaaaaa owes you 25.00 USDC')
    expect(all).toContain('After: Friend aaaaaa owes you 55.00 USDC')
    expect(all).toMatch(/Due \d/)
    expect(all).toContain('Taxi')
    expect(all).toContain(debtsCopy.signNote)
    expect(all).not.toContain(debtsCopy.viaCode)
    for (const banned of BANNED) expect(all).not.toMatch(banned)
    await press(r.root, 'Decline')
    await press(r.root, 'Sign')
    expect([onSign.mock.calls.length, onDecline.mock.calls.length]).toEqual([1, 1])
  })

  it('every button has its label and the copy has no banned words', async () => {
    const r = await mount(<DebtsScreen tabs={[summary()]} {...money} onOpen={vi.fn()} onNew={vi.fn()} />)
    expect(byLabel(r.root, 'New debt')).toBeTruthy()
    const strings = JSON.stringify(debtsCopy, (_, v) => (typeof v === 'function' ? v('Friend aaaaaa', '1.00 USDC') : v))
    for (const banned of BANNED) expect(strings).not.toMatch(banned)
  })
})
