import { act, type ReactElement } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { ConsentView } from './consent-view'
import { HostScreen } from './host-screen'
import { IndexScreen } from './index-screen'
import { JoinScreen } from './join-screen'
import { RemainderSection } from './remainder-section'
import { SessionScreen } from './session-screen'
import { formatDate } from '../debts/format'
import { fixtures } from './testing/screen-fixtures'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (n: string | string[]) => (Array.isArray(n) ? n.map(() => '#000000') : '#000000'),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
vi.mock('../qr/qr-code', () => ({ QrCode: () => null }))
vi.mock('../qr/qr-scanner', () => ({ QrScanner: () => null }))
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

const mount = async (el: ReactElement) => (await act(async () => create(el))).root
const texts = (root: ReactTestInstance) =>
  root.findAllByType('Text' as never).map((n) => [n.props.children].flat().join(''))
const byId = (root: ReactTestInstance, id: string) =>
  root.findAll((n) => n.props.testID === id && typeof n.type === 'string')[0]
const press = async (node: ReactTestInstance) => act(async () => node.props.onPress())

describe('index screen', () => {
  it('shows_the_honest_intro_and_both_entries', async () => {
    const onHost = vi.fn(),
      onJoin = vi.fn()
    const root = await mount(<IndexScreen recent={[]} onHost={onHost} onJoin={onJoin} onOpen={vi.fn()} />)
    expect(texts(root)).toContain('A debt is a record between you and a friend, confirmed on both phones.')
    await press(byId(root, 'netting-host'))
    await press(byId(root, 'netting-join'))
    expect([onHost.mock.calls.length, onJoin.mock.calls.length]).toEqual([1, 1])
  })
  it('lists_recent_sessions_with_their_state_words', async () => {
    const root = await mount(
      <IndexScreen recent={fixtures.recent} onHost={vi.fn()} onJoin={vi.fn()} onOpen={vi.fn()} />,
    )
    expect(texts(root).join('\n')).toMatch(/Done for this phone|Recorded publicly|stay as they were/)
  })
})

describe('host screen', () => {
  it('lobby_shows_the_code_the_count_and_a_disabled_start_below_two_people', async () => {
    const root = await mount(
      <HostScreen
        view={fixtures.lobby(1)}
        invite="buckspay://netting/join?i=AAAA"
        onStart={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(byId(root, 'netting-qr')).toBeDefined()
    expect(texts(root)).toContain('1 joined')
    expect(byId(root, 'netting-start').props.accessibilityState).toMatchObject({ disabled: true })
  })
  it('start_is_enabled_from_two_people_and_calls_back', async () => {
    const onStart = vi.fn()
    const root = await mount(
      <HostScreen
        view={fixtures.lobby(2)}
        invite="buckspay://netting/join?i=AAAA"
        onStart={onStart}
        onCancel={vi.fn()}
      />,
    )
    await press(byId(root, 'netting-start'))
    expect(onStart).toHaveBeenCalledTimes(1)
  })
  it('a_radio_failure_names_the_reason_and_after_two_failures_offers_one_at_a_time', async () => {
    const onOne = vi.fn()
    const first = await mount(
      <HostScreen
        view={fixtures.lobby(1)}
        invite="x"
        failure={{ reason: 'RadioOff', count: 1 }}
        onStart={vi.fn()}
        onCancel={vi.fn()}
        onOneAtATime={onOne}
      />,
    )
    expect(texts(first).join('\n')).toMatch(/Bluetooth/)
    expect(byId(first, 'netting-one-at-a-time')).toBeUndefined()
    const second = await mount(
      <HostScreen
        view={fixtures.lobby(1)}
        invite="x"
        failure={{ reason: 'Error', count: 2 }}
        onStart={vi.fn()}
        onCancel={vi.fn()}
        onOneAtATime={onOne}
      />,
    )
    await press(byId(second, 'netting-one-at-a-time'))
    expect(onOne).toHaveBeenCalledTimes(1)
  })
})

describe('join screen', () => {
  it('scanning_then_connecting_then_not_found', async () => {
    const scan = await mount(<JoinScreen phase="scan" onText={vi.fn()} onCancel={vi.fn()} />)
    expect(byId(scan, 'netting-scan-hint')).toBeDefined()
    const connecting = await mount(<JoinScreen phase="connecting" onText={vi.fn()} onCancel={vi.fn()} />)
    expect(texts(connecting)).toContain('Joining…')
    const lost = await mount(<JoinScreen phase="not-found" onText={vi.fn()} onCancel={vi.fn()} />)
    expect(texts(lost)).toContain("Couldn't find your friend's phone. Stay close and try again.")
  })
})

describe('consent view', () => {
  it('lists_only_my_tabs_with_due_dates_and_says_the_balance_does_not_change', async () => {
    const root = await mount(
      <ConsentView view={fixtures.consent} symbol="USDC" decimals={6} onSign={vi.fn()} onDecline={vi.fn()} />,
    )
    const shown = texts(root).join('\n')
    expect(shown).toMatch(/Before/)
    expect(shown).toMatch(/After/)
    expect(shown).toMatch(/Due /)
    expect(shown).toMatch(/On demand/)
    expect(shown).toMatch(/Your balance doesn't change: \+?3\.00 USDC/)
    expect(shown).not.toContain(fixtures.otherPeoplesSafetyCode)
  })
  it('sign_and_decline_call_back_and_are_labelled_buttons', async () => {
    const onSign = vi.fn(),
      onDecline = vi.fn()
    const root = await mount(
      <ConsentView view={fixtures.consent} symbol="USDC" decimals={6} onSign={onSign} onDecline={onDecline} />,
    )
    await press(byId(root, 'netting-sign'))
    await press(byId(root, 'netting-decline'))
    expect([onSign.mock.calls.length, onDecline.mock.calls.length]).toEqual([1, 1])
    expect(byId(root, 'netting-sign').props.accessibilityLabel).toBe('Confirm')
  })
})

describe('session screen', () => {
  it.each(['waiting', 'agreed', 'recorded', 'void', 'undecided', 'abandoned', 'nothing'] as const)(
    'renders_the_%s_state_with_its_exact_text',
    async (state) => {
      const view = fixtures.view(state)
      const root = await mount(<SessionScreen view={view} symbol="USDC" decimals={6} {...fixtures.noopHandlers} />)
      expect(texts(root)).toContain(view.headline)
      expect(texts(root).join('\n')).toContain(view.body)
    },
  )
  it('proof_flags_show_their_sentence_and_the_result_stays_agreed', async () => {
    const root = await mount(
      <SessionScreen
        view={fixtures.view('agreed', { proof: 'invalid' })}
        symbol="USDC"
        decimals={6}
        {...fixtures.noopHandlers}
      />,
    )
    expect(texts(root).join('\n')).toMatch(/didn't check out/)
    expect(texts(root).join('\n')).toMatch(/Agreed\. It's done once recorded/)
  })
})

describe('record fee', () => {
  it('the_fee_prompt_appears_only_when_the_free_lane_is_capped_and_pressing_it_calls_back', async () => {
    const onPayFee = vi.fn()
    const without = await mount(
      <SessionScreen view={fixtures.view('agreed')} symbol="USDC" decimals={6} {...fixtures.noopHandlers} />,
    )
    expect(byId(without, 'netting-pay-fee')).toBeUndefined()
    const root = await mount(
      <SessionScreen
        view={fixtures.view('agreed')}
        fee={{ lamports: 1_000_000 }}
        symbol="USDC"
        decimals={6}
        {...fixtures.noopHandlers}
        onPayFee={onPayFee}
      />,
    )
    expect(byId(root, 'netting-pay-fee').props.accessibilityLabel).toBe('Pay the fee, about 0.001 SOL')
    await press(byId(root, 'netting-pay-fee'))
    expect(onPayFee).toHaveBeenCalledTimes(1)
  })

  it('the_privacy_lines_name_who_sees_what', async () => {
    const root = await mount(<HostScreen view={fixtures.lobby(2)} invite="x" onStart={vi.fn()} onCancel={vi.fn()} />)
    const shown = texts(root).join('\n')
    expect(shown).toContain(
      'Everyone in the session sees who is in it. The phone that runs the session sees who owes whom.',
    )
    expect(shown).toContain('The phone that passes a payment on sees which reserve it is paid from.')
    const result = await mount(
      <SessionScreen view={fixtures.view('agreed')} symbol="USDC" decimals={6} {...fixtures.noopHandlers} />,
    )
    expect(texts(result).join('\n')).toContain(
      'Paying the recording fee, or recording it yourself, shows publicly that your wallet took part in cancelling debts.',
    )
  })
})

describe('remainder section', () => {
  it('shows_each_state_and_never_says_paid_for_good_before_settled', async () => {
    const rows = fixtures.remainderRows
    const root = await mount(
      <RemainderSection rows={rows} symbol="USDC" decimals={6} settleTogether={false} {...fixtures.noopHandlers} />,
    )
    const shown = texts(root).join('\n')
    expect(shown).toMatch(/Pay 5\.00 USDC now/)
    expect(shown).toMatch(/Paid, being credited/)
    expect(shown).toMatch(/Credited/)
    expect(shown).toMatch(/This payment failed\. The debt is back to 2\.00 USDC\./)
    expect(shown).toMatch(/We can't tell yet whether this payment was credited/)
    expect(shown).toMatch(/We couldn't follow this payment/)
    expect(shown).not.toMatch(/Claim filed/)
    expect(shown).not.toMatch(/for good now/)
  })
  it('a_failed_payment_offers_claim_options_that_say_a_claim_pays_nothing', async () => {
    const onClaim = vi.fn()
    const root = await mount(
      <RemainderSection
        rows={fixtures.remainderRows}
        symbol="USDC"
        decimals={6}
        settleTogether={false}
        {...fixtures.noopHandlers}
        onClaimOptions={onClaim}
      />,
    )
    expect(texts(root)).toContain(
      "Reporting the loss destroys the other person's security deposit. It does not pay you.",
    )
    await press(byId(root, 'remainder-claim-3'))
    expect(onClaim).toHaveBeenCalledWith(fixtures.remainderRows[3].tab)
  })

  it('the_creditor_is_told_to_settle_or_spend_the_payment_before_the_window_ends', async () => {
    const root = await mount(
      <RemainderSection
        rows={fixtures.remainderRows}
        settleBy={1_800_000_000}
        symbol="USDC"
        decimals={6}
        settleTogether={false}
        {...fixtures.noopHandlers}
      />,
    )
    expect(texts(root).join('\n')).toContain(
      `Use this payment, or let it be credited, before ${formatDate(1_800_000_000)} for the debt to go down.`,
    )
  })

  it('pay_and_later_call_back_with_the_tab', async () => {
    const onPay = vi.fn(),
      onLater = vi.fn()
    const root = await mount(
      <RemainderSection
        rows={fixtures.remainderRows}
        symbol="USDC"
        decimals={6}
        settleTogether={false}
        {...fixtures.noopHandlers}
        onPay={onPay}
        onLater={onLater}
      />,
    )
    await press(byId(root, 'remainder-pay-0'))
    await press(byId(root, 'remainder-later-0'))
    expect(onPay).toHaveBeenCalledWith(fixtures.remainderRows[0].tab)
    expect(onLater).toHaveBeenCalledWith(fixtures.remainderRows[0].tab)
  })
  it('settle_together_is_off_by_default_and_carries_its_linkability_note', async () => {
    const onSet = vi.fn()
    const root = await mount(
      <RemainderSection
        rows={fixtures.remainderRows}
        symbol="USDC"
        decimals={6}
        settleTogether={false}
        {...fixtures.noopHandlers}
        onSettleTogether={onSet}
      />,
    )
    const toggle = byId(root, 'netting-settle-together')
    expect(toggle.props.value).toBe(false)
    expect(toggle.props.accessibilityRole).toBe('switch')
    expect(texts(root)).toContain('Crediting together shows publicly that these payments were made together.')
    await act(async () => toggle.props.onValueChange(true))
    expect(onSet).toHaveBeenCalledWith(true)
  })
  it('a_simplification_prompt_needs_an_explicit_approval', async () => {
    const onApprove = vi.fn()
    const root = await mount(
      <RemainderSection
        rows={[]}
        simplify={fixtures.simplify}
        symbol="USDC"
        decimals={6}
        settleTogether={false}
        {...fixtures.noopHandlers}
        onApproveSimplify={onApprove}
      />,
    )
    expect(onApprove).not.toHaveBeenCalled()
    expect(texts(root).join('\n')).toMatch(/Everyone on the path has to agree\./)
    await press(byId(root, 'simplify-approve'))
    expect(onApprove).toHaveBeenCalledWith(fixtures.simplify.id, true)
  })
})

describe('controls', () => {
  it('every_pressable_has_a_role_a_label_and_a_48dp_floor', async () => {
    const screens: ReactElement[] = [
      <IndexScreen key="i" recent={fixtures.recent} onHost={vi.fn()} onJoin={vi.fn()} onOpen={vi.fn()} />,
      <HostScreen key="h" view={fixtures.lobby(2)} invite="x" onStart={vi.fn()} onCancel={vi.fn()} />,
      <ConsentView key="c" view={fixtures.consent} symbol="USDC" decimals={6} onSign={vi.fn()} onDecline={vi.fn()} />,
      <SessionScreen key="s" view={fixtures.view('agreed')} symbol="USDC" decimals={6} {...fixtures.noopHandlers} />,
      <RemainderSection
        key="r"
        rows={fixtures.remainderRows}
        symbol="USDC"
        decimals={6}
        settleTogether={false}
        {...fixtures.noopHandlers}
      />,
    ]
    for (const screen of screens) {
      const root = await mount(screen)
      for (const node of root.findAllByType('Pressable' as never)) {
        expect(node.props.accessibilityRole).toBeTruthy()
        expect(node.props.accessibilityLabel).toBeTruthy()
        expect(String(node.props.className)).toMatch(/min-h-(12|14|16|20|28)|size-12/)
      }
    }
  })
})
