import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { LostNote } from './lost-note'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

const base = {
  hop: 2 as number | null,
  steps: 4,
  culprit: Uint8Array.of(2, ...new Uint8Array(32).fill(2)),
  burned: 80_000_000n as bigint | null,
  decimals: 6,
  symbol: 'USDC',
}
const texts = (root: ReactTestInstance) =>
  root.findAllByType('Text' as never).map((node) => [node.props.children].flat().join(''))
const shown = async (props: Partial<Parameters<typeof LostNote>[0]> & { state: 'filed' | 'already' | 'late' }) =>
  texts((await act(async () => create(<LostNote {...base} {...props} />))).root)

describe('LostNote', () => {
  it('names the step and the culprit code and says the bond is not paid to you', async () => {
    const lines = await shown({ state: 'filed' })
    expect(lines.some((line) => /step 3 of 4 \(code [A-Z2-9]{4}-[A-Z2-9]{4}\)/.test(line))).toBe(true)
    expect(lines.join(' ')).toContain('80.00 USDC destroyed')
    expect(lines.join(' ')).toContain('You are not repaid')
  })

  it('says the loss was reported already', async () => {
    expect((await shown({ state: 'already' })).join(' ')).toContain('already reported')
  })

  it('names the issuer when the chain was never backed', async () => {
    expect((await shown({ state: 'filed', hop: null })).join(' ')).toContain('The issuer')
  })

  it('never uses protection words', async () => {
    expect((await shown({ state: 'filed' })).join(' ')).not.toMatch(/protected|insured|refund|guarantee/i)
  })

  it('says nothing burned when reported late', async () => {
    expect((await shown({ state: 'late', burned: null })).join(' ')).toContain('nothing was burned')
  })
})
