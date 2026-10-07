import { act, useEffect, useState } from 'react'
import { create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Transport } from '../../transport/types'
import { copy } from '../payment/copy'
import { type ReceiveFlow, ReceiveFlowProvider, useReceiveFlow } from './use-receive-flow'

const mocks = vi.hoisted(() => ({
  start: undefined as undefined | (() => Promise<unknown>),
  attesters: [] as unknown[],
}))

vi.mock('./receive-gate', () => ({ receiveGate: vi.fn() }))
vi.mock('@wallet-ui/react-native-kit', () => ({ useMobileWallet: () => ({ client: { rpc: {} } }) }))
vi.mock('../event/point', () => ({ pointReceiverOf: vi.fn() }))
vi.mock('../event/consumed', () => ({ entriesSince: vi.fn() }))
vi.mock('../payment/receiver', () => ({ receiverOf: vi.fn() }))
vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('../payment/payments-provider', () => ({
  nowSeconds: () => Math.floor(Date.now() / 1000),
  usePayments: () => ({
    db: undefined,
    domains: {},
    attesters: mocks.attesters,
    hasTrustedAttesters: mocks.attesters.length > 0,
    witnessSettings: { ask: false, requireFrom: null, answer: false },
    witnessPort: undefined,
  }),
}))
vi.mock('../identity/use-device-identity', () => ({
  useDeviceIdentity: () => ({ deviceKey: { publicKey: new Uint8Array(33).fill(2) } }),
}))
vi.mock('../payment/use-qr-session', () => ({
  useQrSession: () => ({ transport: {}, texts: undefined, progress: undefined, push: () => {}, clear: () => {} }),
}))
vi.mock('../event/use-point-mode', () => ({ usePointMode: () => ({ mode: undefined }) }))
vi.mock('../transport/use-transports', () => ({
  useTransports: (entries: unknown[]) => ({ offered: [], ready: entries }),
  useTransportChoice: () => ({ chosen: undefined, choose: () => {} }),
}))
vi.mock('../transport/registry', () => ({
  qrEntry: () => ({ id: 'qr', label: 'Code', check: async () => ({ ready: true }), start: () => mocks.start?.() }),
  nfcEntry: { id: 'nfc' },
  nearbyEntry: { id: 'nearby' },
}))
vi.mock('../../payment/receive-flow', () => ({ showRequest: vi.fn(async () => {}), receivePayment: vi.fn() }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const attester = { id: new Uint8Array(8).fill(1), active: true, syncedAt: Math.floor(Date.now() / 1000) }
const transport = {
  send: async () => {},
  receive: async () => undefined,
  close: async () => {},
} as unknown as Transport
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let flow: ReceiveFlow
let tap: () => Promise<string | undefined>
let session: { mounted: boolean; popped: boolean }

/** Stands for the receive tab and the session screen: it opens the session once create has returned, as the app does. */
function Harness() {
  const current = useReceiveFlow()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    flow = current
    tap = async () => {
      const failure = await current.create('1', '', false)
      if (failure === undefined) setOpen(true)
      return failure
    }
  })
  useEffect(() => {
    if (open) session.mounted = true
  }, [open])
  useEffect(() => {
    if (open && current.state.name === 'composing') {
      session.popped = true
    }
  }, [open, current.state.name])
  return null
}

const render = () =>
  act(async () => {
    create(
      <ReceiveFlowProvider>
        <Harness />
      </ReceiveFlowProvider>,
    )
  })

beforeEach(() => {
  session = { mounted: false, popped: false }
  mocks.attesters = [attester]
  mocks.start = async () => {
    await delay(30)
    return transport
  }
})

describe('receive flow create', () => {
  it('keeps the session screen once the request is shown, and ignores a second tap', async () => {
    await render()
    let first: Promise<string | undefined> | undefined
    let second: string | undefined
    await act(async () => {
      first = tap()
      second = await tap()
      await first
    })
    expect(await first).toBeUndefined()
    expect(second).toBe('busy')
    expect(flow.state.name).toBe('requesting')
    expect(session).toEqual({ mounted: true, popped: false })
  })

  it('still asks to connect when no attester can be used', async () => {
    mocks.attesters = []
    await render()
    let failure: string | undefined
    await act(async () => {
      failure = await tap()
    })
    expect(failure).toBe('connect')
  })

  it('says the medium could not start and stays on the form when the transport fails to open', async () => {
    mocks.start = async () => {
      await delay(10)
      throw new Error('no radio')
    }
    await render()
    let failure: string | undefined
    await act(async () => {
      failure = await tap()
    })
    expect(failure).toBe('transport')
    expect(flow.state.name).toBe('composing')
    expect(copy.receive.transportFailed).toContain('Try Code instead')
  })
})
