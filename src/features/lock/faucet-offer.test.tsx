import { act, type ReactElement } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { feedback } from '../../feedback'
import { GatewayError } from './gateway'
import { FaucetOffer } from './faucet-offer'

vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#123456') : '#123456'),
}))
vi.mock('../../feedback', () => ({ feedback: { cue: vi.fn() } }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const render = async (element: ReactElement) => (await act(async () => create(element))).root
const texts = (root: ReactTestInstance) =>
  root.findAllByType('Text' as never).map((node) => [node.props.children].flat().join(''))
const button = (root: ReactTestInstance) =>
  root.findAll((node) => node.props.testID === 'faucet-get' && node.props.onPress)[0]

const offer = (over: Partial<Parameters<typeof FaucetOffer>[0]> = {}) => {
  const onClaimed = vi.fn()
  const gateway = {
    faucetOffer: vi.fn(async () => ({ amount: 20_000_000n })),
    faucetClaim: vi.fn(async () => ({ signature: 'sig', amount: 20_000_000n })),
  }
  const read = vi.fn(async () => 20_000_000n)
  const element = (
    <FaucetOffer
      wallet="Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"
      balance={0n}
      needed={5_000_000n}
      symbol="USDC"
      decimals={6}
      gateway={gateway}
      read={read}
      onClaimed={onClaimed}
      {...over}
    />
  )
  return { element, gateway, read, onClaimed }
}

beforeEach(() => vi.mocked(feedback.cue).mockClear())

describe('the offer of test money', () => {
  it('offers the amount the faucet gives when the wallet has less than it needs', async () => {
    const { element } = offer()
    const root = await render(element)
    expect(texts(root)).toEqual(expect.arrayContaining(['Get test USDC', '+20.00 USDC']))
  })

  it('stays out of the way when the wallet already has enough', async () => {
    const { element, gateway } = offer({ balance: 5_000_000n })
    const root = await render(element)
    expect(button(root)).toBeUndefined()
    expect(gateway.faucetOffer).not.toHaveBeenCalled()
  })

  it('stays out of the way on a gateway that has no faucet', async () => {
    const { element, gateway } = offer()
    gateway.faucetOffer.mockResolvedValue(undefined as never)
    expect(button(await render(element))).toBeUndefined()
  })

  it('asks for the money, reads what the wallet has now and says so with a success cue', async () => {
    const { element, gateway, read, onClaimed } = offer()
    const root = await render(element)
    await act(async () => button(root).props.onPress())
    expect(gateway.faucetClaim).toHaveBeenCalledWith('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS')
    expect(read).toHaveBeenCalledOnce()
    expect(onClaimed).toHaveBeenCalledWith(20_000_000n)
    expect(texts(root)).toContain('Added 20.00 USDC')
    expect(feedback.cue).toHaveBeenCalledWith('success')
  })

  it('says when the wallet may ask again, in hours, instead of failing', async () => {
    const { element, gateway, onClaimed } = offer()
    gateway.faucetClaim.mockRejectedValue(new GatewayError(429, 'this wallet claimed lately', { retryAfter: 82_800 }))
    const root = await render(element)
    await act(async () => button(root).props.onPress())
    expect(texts(root).some((line) => line.includes('23 hours'))).toBe(true)
    expect(onClaimed).not.toHaveBeenCalled()
  })

  it('says it could not and lets the person try again when anything else goes wrong', async () => {
    const { element, gateway } = offer()
    gateway.faucetClaim.mockRejectedValue(new Error('offline'))
    const root = await render(element)
    await act(async () => button(root).props.onPress())
    expect(texts(root)).toContain('Could not get it. Try again.')
    expect(feedback.cue).toHaveBeenCalledWith('problem')
    expect(button(root)).toBeDefined()
  })
})
