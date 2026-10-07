import { bytesToHex } from '@noble/hashes/utils.js'
import { View } from 'react-native'
import { act, useEffect, useState } from 'react'
import { create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQrPair } from '../../transport/testing/qr-pair'
import { decodeBundle, type PaymentRequest } from '../../payment/messages'
import { encodeReceipt, encodeRequest } from '../../payment/messages'
import { Reason } from '../../payment/reasons'
import { encodeFrames } from '../../transport/framing'
import { qrFrameLimits } from '../../transport/qr/limits'
import { frameToText } from '../../transport/qr/text'
import { MessageKind } from '../../transport/types'
import { confirmAndSend } from '../../payment/pay'
import { planPayment } from '../../payment/preflight'
import { createSoftSigner } from '../../payment/testing/soft-guard'
import { ATTESTER, makeTicket, MINT, NOTE_DOMAIN, party, PROGRAM } from '../../payment/testing/world'
import type { NoteDb } from '../notes/db'
import { nextCumEnd, unfinishedPayments } from '../notes/outgoing'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import PaySend from '../../app/pay/send'
import { type PayFlow, PayFlowProvider, usePayFlow } from './use-pay-flow'

const mocks = vi.hoisted(() => ({
  db: undefined as unknown,
  locks: [] as unknown[],
  sign: undefined as undefined | ((...args: unknown[]) => unknown),
  open: (_open: boolean) => {},
}))

vi.mock('expo-linking', () => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })), openURL: vi.fn() }))
vi.mock('../qr/e2e-source', () => ({ installE2eScan: () => () => {} }))
vi.mock('../witness/nearby-check', () => ({ NearbyCheck: () => null }))
vi.mock('../payment/result-mark', () => ({ ResultMark: () => null }))
vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
vi.mock('expo-symbols', () => ({ unstable_getMaterialSymbolSourceAsync: vi.fn(async () => ({ uri: 'icon.png' })) }))

vi.mock('expo-router', () => ({
  router: { push: () => mocks.open(true), back: () => mocks.open(false), replace: vi.fn() },
}))
vi.mock('../payment/payments-provider', () => ({
  nowSeconds: () => 1_800_000_025,
  usePayments: () => ({
    db: mocks.db,
    domains: { noteDomain: NOTE_DOMAIN, program: PROGRAM },
    witnessSettings: { ask: false, requireFrom: null, answer: false },
    witnessPort: undefined,
  }),
}))
vi.mock('../identity/use-device-identity', () => ({
  useDeviceIdentity: () => ({ deviceKey: { publicKey: new Uint8Array(33).fill(2) } }),
}))
vi.mock('../attesters/use-offline-locks', () => ({
  useOfflineLocks: () => ({ locks: mocks.locks, reload: async () => {}, allowance: () => 0n }),
}))
vi.mock('../transport/use-transports', () => ({
  useTransports: (entries: unknown[]) => ({ offered: [], ready: entries }),
  useTransportChoice: () => ({ chosen: undefined, choose: () => {} }),
}))
vi.mock('../transport/registry', () => ({
  qrEntry: (session: { transport: unknown }) => ({
    id: 'qr',
    check: async () => ({ ready: true }),
    start: async () => session.transport,
  }),
  nfcEntry: { id: 'nfc' },
  nearbyEntry: { id: 'nearby' },
}))
vi.mock('../../payment/native-sign', () => ({ signStoredIssue: (...args: unknown[]) => mocks.sign?.(...args) }))
vi.mock('./tokens', async () => {
  const world = await import('../../payment/testing/world')
  const { bytesToHex } = await import('@noble/hashes/utils.js')
  const token = { symbol: 'USDC', decimals: 6 }
  return { BUILD_TOKEN: token, BUILD_TOKENS: new Map([[bytesToHex(world.MINT), token]]) }
})
vi.mock('../../keys', () => ({ signSpend: vi.fn(), nativeErrorCode: () => undefined }))
vi.mock('../../payment/authenticate', () => ({ authenticate: async () => true }))
vi.mock('../qr/qr-presenter', () => ({
  QrPresenter: ({ texts }: { texts: readonly string[] }) => (
    <View testID="qr-shown" accessibilityLabel={texts.join('|')} />
  ),
}))
vi.mock('../qr/scan-screen', () => ({ ScanScreen: () => null }))
vi.mock('../transport/waiting', () => ({ WaitingScreen: () => null }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const payer = party(1)
const shop = party(2)
const NOW = 1_800_000_000
const request: PaymentRequest = {
  owner: { type: 'device', key: shop.key },
  mint: MINT,
  amount: 1_000_000n,
  now: NOW,
  minWindow: 3600,
  minHops: 1,
  attesters: [ATTESTER.id],
  memo: '',
  witness: 'none',
}

let db: NoteDb
let flow: PayFlow

function Harness() {
  const current = usePayFlow()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    mocks.open = setOpen
  }, [])
  useEffect(() => {
    flow = current
  })
  if (!open) return null
  return <PaySend />
}

const limits = {
  noteLifetime: 72 * 3600,
  noteHops: 3,
  requestTtl: 600,
  skewTolerance: 120,
  transferMargin: 120,
  maxPayment: 100_000_000n,
  biometricFrom: 20_000_000n,
  biometricDaily: 50_000_000n,
}

const lockOf = async () => ({
  lockSeq: 3,
  mint: MINT,
  bond: 200_000_000n,
  backing: 100_000_000n,
  lockUntil: NOW + 30 * 86400,
  nextCumEnd: await nextCumEnd(db, payer.key, 3),
  ticket: makeTicket({
    device: payer.key,
    mint: MINT,
    lockSeq: 3,
    bond: 200_000_000n,
    backing: 100_000_000n,
    lockUntil: NOW + 30 * 86400,
  }),
})

async function seedSignedPayment() {
  const signer = createSoftSigner(payer)
  mocks.sign = signer.sign as never
  const planned = planPayment(request, {
    now: NOW + 20,
    me: payer.key,
    noteDomain: NOTE_DOMAIN,
    program: PROGRAM,
    locks: [await lockOf()],
    tokens: new Map([[bytesToHex(MINT), { symbol: 'USDC', decimals: 6 }]]),
    limits,
    salt: () => crypto.getRandomValues(new Uint8Array(16)),
    knownReceivers: new Set(),
    paidRequests: new Set(),
    paidToday: 0n,
  })
  if (!planned.ok) throw new Error(planned.reason)
  const [side, other] = createQrPair({ drop: 0, seed: 1 })
  await confirmAndSend(planned.plan, request, 'qr', {
    db,
    sign: signer.sign,
    transport: side,
    authenticate: async () => true,
    noteDomain: NOTE_DOMAIN,
    now: () => NOW + 25,
  })
  await Promise.all([side.close(), other.close()])
  return { signer, row: (await unfinishedPayments(db))[0] }
}

describe('an unfinished payment shown again', () => {
  beforeEach(async () => {
    db = createNodeDb()
    await migrate(db)
    mocks.db = db
  })

  it('shows the stored bundle as a code again after Done, on the send screen, without signing', async () => {
    const { signer, row } = await seedSignedPayment()
    const signed = signer.signatures
    let tree!: ReturnType<typeof create>
    await act(async () => {
      tree = create(
        <PayFlowProvider>
          <Harness />
        </PayFlowProvider>,
      )
    })
    const resume = async () => {
      await act(async () => {
        await flow.resume(row.messageId)
        mocks.open(true)
      })
    }
    await resume()
    const shown = () =>
      tree.root
        .findAll((n) => typeof n.type === 'string' && n.props.testID === 'qr-shown')
        .map((n) => n.props.accessibilityLabel)
    expect(shown()).toHaveLength(1)
    await act(async () => flow.finish())
    expect(shown()).toHaveLength(0)
    await resume()
    expect(shown()).toHaveLength(1)
    await resume()
    await act(async () => flow.scanReceipt())
    await act(async () => flow.cancelReceipt())
    await act(async () => flow.finish())
    await resume()
    expect(shown()).toHaveLength(1)
    await act(async () => flow.scanReceipt())
    const receipt = encodeReceipt({ accepted: true, reason: Reason.Accepted, messageId: row.messageId })
    for (const text of encodeFrames({ kind: MessageKind.Receipt, payload: receipt }, qrFrameLimits()).map(
      frameToText,
    )) {
      await act(async () => flow.submitText(text))
    }
    expect(flow.state.name).toBe('confirmed')
    expect(decodeBundle(row.bundle!).issue.message.amount).toBe(1_000_000n)
    expect(signer.signatures).toBe(signed)
    expect(await unfinishedPayments(db)).toEqual([])
    await act(async () => tree.unmount())
  })

  it('shows the code again when the screen was left while the confirmation was being scanned', async () => {
    const { signer, row } = await seedSignedPayment()
    const signed = signer.signatures
    let tree!: ReturnType<typeof create>
    await act(async () => {
      tree = create(
        <PayFlowProvider>
          <Harness />
        </PayFlowProvider>,
      )
    })
    await act(async () => {
      await flow.resume(row.messageId)
      mocks.open(true)
    })
    await act(async () => flow.scanReceipt())
    expect(flow.state.name).toBe('awaiting-receipt')
    await act(async () => mocks.open(false))
    await act(async () => {
      await flow.resume(row.messageId)
      mocks.open(true)
    })
    expect(flow.state.name).toBe('presenting')
    expect(tree.root.findAll((n) => typeof n.type === 'string' && n.props.testID === 'qr-shown')).toHaveLength(1)
    expect(signer.signatures).toBe(signed)
    await act(async () => tree.unmount())
  })

  it('plans a new request while an earlier payment is unconfirmed, and says a paid one is already paid', async () => {
    await seedSignedPayment()
    mocks.locks = [await lockOf()]
    let tree!: ReturnType<typeof create>
    await act(async () => {
      tree = create(
        <PayFlowProvider>
          <Harness />
        </PayFlowProvider>,
      )
    })
    const read = async (wanted: typeof request) => {
      await act(async () => flow.scan())
      for (const text of encodeFrames(
        { kind: MessageKind.Request, payload: encodeRequest(wanted) },
        qrFrameLimits(),
      ).map(frameToText)) {
        await act(async () => flow.submitText(text))
      }
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
    }
    await read({ ...request, amount: 2_000_000n })
    expect(flow.state).toMatchObject({ name: 'reviewing' })
    await act(async () => flow.back())
    await read(request)
    expect(flow.state).toMatchObject({ name: 'refused', reason: 'AlreadyPaid' })
    await act(async () => tree.unmount())
  })

  it('scans a new request after the send screen was left without pressing Done', async () => {
    const { row } = await seedSignedPayment()
    let tree!: ReturnType<typeof create>
    await act(async () => {
      tree = create(
        <PayFlowProvider>
          <Harness />
        </PayFlowProvider>,
      )
    })
    await act(async () => {
      await flow.resume(row.messageId)
      mocks.open(true)
    })
    await act(async () => mocks.open(false))
    await act(async () => flow.scan())
    expect(flow.state).toMatchObject({ name: 'scanning' })
    await act(async () => tree.unmount())
  })

  it('says so when a request was read and the payment could not be planned', async () => {
    await seedSignedPayment()
    mocks.locks = [await lockOf()]
    await db.run('DROP TABLE received_note')
    let tree!: ReturnType<typeof create>
    await act(async () => {
      tree = create(
        <PayFlowProvider>
          <Harness />
        </PayFlowProvider>,
      )
    })
    await act(async () => flow.scan())
    for (const text of encodeFrames(
      { kind: MessageKind.Request, payload: encodeRequest(request) },
      qrFrameLimits(),
    ).map(frameToText)) {
      await act(async () => flow.submitText(text))
    }
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(flow.state).toMatchObject({ name: 'scanning', unreadable: true })
    await act(async () => tree.unmount())
  })
})
