import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaymentRequest } from '../../payment/messages'
import { planPayment, type Plan } from '../../payment/preflight'
import type { RespendPlan } from '../../payment/respend'
import { makeTicket, MINT, NOTE_DOMAIN, party, PROGRAM, respendPlan } from '../../payment/testing/world'
import { PAY_LIMITS } from './limits'
import { PayReview } from './review'
import { BUILD_TOKENS } from './tokens'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))
vi.mock('expo-symbols', () => ({ unstable_getMaterialSymbolSourceAsync: vi.fn(async () => ({ uri: 'icon.png' })) }))
const protect = vi.fn(async (_enabled: boolean) => {})
vi.mock('../../../modules/touch-guard/src/TouchGuardModule', () => ({
  default: { protect: (e: boolean) => protect(e) },
}))
vi.mock('./tokens', async () => {
  const { bytesToHex } = await import('@noble/hashes/utils.js')
  const mint = new Uint8Array(32).fill(0x55)
  const token = { symbol: 'USDC', decimals: 6 }
  return { BUILD_TOKEN: token, BUILD_MINT_BYTES: mint, BUILD_TOKENS: new Map([[bytesToHex(mint), token]]) }
})

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

const payer = party(1)
const shop = party(2)
const NOW = 1_800_000_000

function plan(over: Partial<PaymentRequest> = {}, paidToday = 0n): { request: PaymentRequest; plan: Plan } {
  const request: PaymentRequest = {
    owner: { type: 'device', key: shop.key },
    mint: MINT,
    amount: 5_000_000n,
    now: NOW,
    minWindow: 3600,
    witness: 'none',
    minHops: 1,
    attesters: [7],
    memo: 'Coffee',
    ...over,
  }
  const ticket = makeTicket({
    device: payer.key,
    mint: MINT,
    lockSeq: 3,
    bond: 800_000_000n,
    backing: 100_000_000n,
    lockUntil: NOW + 30 * 86_400,
  })
  const planned = planPayment(request, {
    now: NOW + 30,
    me: payer.key,
    noteDomain: NOTE_DOMAIN,
    program: PROGRAM,
    locks: [
      {
        lockSeq: 3,
        mint: MINT,
        bond: 800_000_000n,
        backing: 100_000_000n,
        lockUntil: NOW + 30 * 86_400,
        ticket,
        nextCumEnd: 2_000_000n,
      },
    ],
    tokens: BUILD_TOKENS,
    limits: PAY_LIMITS,
    salt: () => crypto.getRandomValues(new Uint8Array(16)),
    knownReceivers: new Set(),
    paidToday,
    paidRequests: new Set(),
  })
  if (!planned.ok) throw new Error(planned.reason)
  return { request, plan: planned.plan }
}

const mount = async (value: Plan | RespendPlan, onConfirm = vi.fn(), busy = false) =>
  act(async () => create(<PayReview plan={value} busy={busy} onConfirm={onConfirm} onCancel={() => {}} />))
const texts = (root: ReactTestInstance) =>
  root.findAllByType('Text' as never).map((node) => [node.props.children].flat().join(''))
const ids = (root: ReactTestInstance) =>
  root
    .findAll((node) => typeof node.props.testID === 'string' && typeof node.type === 'string')
    .map((node) => node.props.testID as string)

beforeEach(() => protect.mockClear())

describe('PayReview', () => {
  it('shows the amount, who, what is left and the three consequences before the Pay button', async () => {
    const renderer = await mount(plan().plan)
    expect(ids(renderer.root)).toEqual([
      'pay-review',
      'pay-to',
      'pay-note',
      'pay-from',
      'pay-consequences',
      'pay-details',
      'pay-confirm',
      'pay-cancel',
    ])
    const shown = texts(renderer.root).join('\n')
    expect(shown).toContain('Pay 5.00 USDC')
    expect(shown).toMatch(/Phone [A-Z2-9]{4}-[A-Z2-9]{4}/)
    expect(shown).toContain('New phone')
    expect(shown).toContain('Compare this code')
    expect(shown).toContain('93.00 USDC left after this payment')
    expect(shown).toContain("You can't cancel it afterwards.")
    expect(shown).toContain('the money stays in your lock')
    expect(shown).toContain('stays used until your lock ends')
  })

  it('builds every figure from the issue that will be signed, whatever happens to the request', async () => {
    const { request, plan: planned } = plan()
    const before = texts((await mount(planned)).root).join('\n')
    request.amount = 99_000_000n
    request.owner = { type: 'device', key: party(9).key }
    request.memo = 'something else'
    const after = texts((await mount(planned)).root).join('\n')
    expect(after).toBe(before)
  })

  it('asks for the biometric wording when the plan says so', async () => {
    const { plan: asked } = plan({ amount: 25_000_000n })
    expect(asked.review.biometric).toBe(true)
    const shown = texts((await mount(asked)).root).join('\n')
    expect(shown).toContain('Confirm and pay 25.00 USDC')
    expect(shown).toContain("You'll be asked for your fingerprint or screen lock.")
    const plain = texts((await mount(plan().plan)).root).join('\n')
    expect(plain).not.toContain('fingerprint')
  })

  it('renders the memo as quoted plain text with its warning and never as a control', async () => {
    const hostile = `Pay $1\n\nTO: attacker${String.fromCodePoint(0x202e)}`
    const renderer = await mount(plan({ memo: hostile }).plan)
    const lines = texts(renderer.root)
    expect(lines).toContain('“Pay $1 TO: attacker”')
    expect(lines.some((line) => line.includes("Written by the other phone. Buckspay hasn't checked it."))).toBe(true)
    expect(lines.join('\n')).not.toContain(String.fromCodePoint(0x202e))
    expect(renderer.root.findAll((node) => node.props.testID === 'pay-note')).not.toHaveLength(0)
    const noMemo = await mount(plan({ memo: '' }).plan)
    expect(texts(noMemo.root).join('\n')).not.toContain('Written by the other phone')
  })

  it('disables Pay at once and ignores a second tap', async () => {
    const onConfirm = vi.fn()
    const renderer = await mount(plan().plan, onConfirm)
    const pay = renderer.root.findByProps({ testID: 'pay-confirm' })
    await act(async () => pay.props.onPress())
    await act(async () => pay.props.onPress())
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(renderer.root.findByProps({ testID: 'pay-confirm' }).props.disabled).toBe(true)
  })

  it('calls the touch guard while mounted and lets go on unmount', async () => {
    const renderer = await mount(plan().plan)
    expect(protect.mock.calls).toEqual([[true]])
    await act(async () => renderer.unmount())
    expect(protect.mock.calls).toEqual([[true], [false]])
  })
})

describe('PayReview of a note passed on', () => {
  it('says it pays from money received, shows the change and whose bond answers, and promises nothing', async () => {
    const renderer = await mount(respendPlan({ kind: 'spend2', change: 3_000_000n }))
    const shown = texts(renderer.root).join('\n')
    expect(shown).toContain('Paying from money you received')
    expect(shown).toMatch(/3\.00 USDC comes back to you/)
    expect(shown).toContain('Your bond answers for this payment')
    expect(shown).not.toMatch(/protected|insured|guarantee|allowance/i)
  })

  it('says how much of the payment covers the fees of settling it, and nothing when there are none', async () => {
    const base = respendPlan({ kind: 'spend2', change: 3_000_000n })
    const withFee = { ...base, review: { ...base.review, amount: 2_020_000n, fee: 20_000n } }
    expect(texts((await mount(withFee)).root).join('\n')).toContain(
      'Includes 0.02 USDC to cover the fees of settling it.',
    )
    expect(texts((await mount(base)).root).join('\n')).not.toContain('Includes')
  })

  it('shows no change line for a payment of the whole note', async () => {
    const shown = texts((await mount(respendPlan({ kind: 'spend1', change: 0n }))).root).join('\n')
    expect(shown).toContain('Paying from money you received')
    expect(shown).not.toContain('comes back to you')
  })
})

describe('PayReview of event credit', () => {
  it('says where the credit can be used', async () => {
    const { plan: sold } = plan()
    const renderer = await act(async () =>
      create(<PayReview plan={sold} event="Feria" busy={false} onConfirm={() => {}} onCancel={() => {}} />),
    )
    expect(texts(renderer.root)).toContain('Only usable at Feria')
    expect(texts((await mount(sold)).root).join('')).not.toContain('Only usable at')
  })
})
