import { act, useEffect } from 'react'
import { create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  quote: undefined as undefined | (() => Promise<{ minAmount: bigint }>),
}))

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('../lock/gateway', () => ({
  BUILD_GATEWAY: { settlementQuote: () => mocks.quote?.() },
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let seen: bigint | undefined

async function mountHook() {
  const { useSettlementMinimum } = await import('./use-settlement-minimum')
  function Probe() {
    const minimum = useSettlementMinimum()
    useEffect(() => {
      seen = minimum
    })
    return null
  }
  await act(async () => void create(<Probe />))
}

beforeEach(() => {
  seen = undefined
  vi.resetModules()
})

describe('the smallest amount the server settles', () => {
  it('is what the server quotes now', async () => {
    mocks.quote = async () => ({ minAmount: 50_000n })
    await mountHook()
    expect(seen).toBe(50_000n)
  })

  it('stays unknown when the server cannot be reached', async () => {
    mocks.quote = () => Promise.reject(new Error('Network request failed'))
    await mountHook()
    expect(seen).toBeUndefined()
  })

  it('keeps the last quote it read while the server is out of reach', async () => {
    mocks.quote = async () => ({ minAmount: 250_000n })
    await mountHook()
    mocks.quote = () => Promise.reject(new Error('Network request failed'))
    await mountHook()
    expect(seen).toBe(250_000n)
  })
})
