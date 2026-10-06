import { bytesToHex } from '@noble/hashes/utils.js'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEVNET_GENESIS_HASH,
  decodeSpend,
  encodeSpend,
  encodeSpendBody,
  GRACE,
  type Spend,
  verifySettlement,
  walkChain,
} from '../../protocol'
import { eventWorld } from '../event/testing'
import { encodeBundle, paymentId } from '../../payment/messages'
import { chainOf, changeOf, planRespend } from '../../payment/respend'
import { reconcileIdentity } from '../notes/ledger'
import { heldOutputs, markRespendSigned, prepareRespend } from '../notes/outgoing'
import { acceptPayment } from '../../payment/receive'
import { createSoftSpendSigner } from '../../payment/testing/soft-guard'
import {
  ATTESTER,
  MINT,
  makeTicket,
  NOTE_DOMAIN,
  NOW,
  party,
  PROGRAM,
  payCtx,
  receiverFor,
  requestTo,
  signIssue,
  signSpendWith,
} from '../../payment/testing/world'
import { GatewayError, type SettlementGateway } from '../lock/gateway'
import { outboxFor } from '../relay/outbox'
import { relayQueue } from '../relay/queue'
import { openAsGateway, parseInner } from '../relay/testing'
import type { NoteDb } from '../notes/db'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { settleHeld, type SettlementDeps, settlementDelay } from './settle-held'

const payer = party(1)
const shop = party(2)
const WALLET = new Uint8Array(32).fill(0x77)

let db: NoteDb
let signer: ReturnType<typeof createSoftSpendSigner>
let sent: { issue: string; spends: string[] }[]
let answers: (() => Promise<unknown>)[]
let claims: (() => Promise<unknown>)[] = []
const claimed: { issue: string; spends: string[] }[] = []
let clock = NOW + 1_000
let acknowledged = true

const gateway = {
  settle: async (request: { issue: string; spends: string[] }) => {
    sent.push(request)
    return (answers.shift() ?? (async () => ({ signature: '5sig' })))()
  },
  claim: async (request: { issue: string; spends: string[] }) => {
    claimed.push(request)
    return (claims.shift() ?? (() => Promise.reject(new Error('network down'))))()
  },
} as unknown as SettlementGateway

const deps = (over: Partial<SettlementDeps> = {}): SettlementDeps => ({
  db,
  wallet: WALLET,
  me: shop.key,
  noteDomain: NOTE_DOMAIN,
  program: PROGRAM,
  signSpend: signer.signSpend,
  gateway,
  now: () => clock,
  salt: () => crypto.getRandomValues(new Uint8Array(16)),
  labelAcknowledged: async () => acknowledged,
  noticeShown: async () => true,
  random: () => 0.5,
  attempts: new Map(),
  ...over,
})

async function receive(cumEnd = 5_000_000n, expiry = NOW + 72 * 3600) {
  const issue = signIssue(payer, {
    issuer: payer.key,
    mint: MINT,
    lockSeq: 3,
    cumEnd,
    salt: new Uint8Array(16).fill(9),
    owner: { type: 'device', key: shop.key },
    amount: 5_000_000n,
    caveats: { expiry, hopsLeft: 3, flags: 0, scopeKind: 0, scope: new Uint8Array(20) },
  })
  const ticket = makeTicket({
    device: payer.key,
    mint: MINT,
    lockSeq: 3,
    bond: 200_000_000n,
    backing: 100_000_000n,
    lockUntil: NOW + 30 * 86400,
  })
  const outcome = await acceptPayment(encodeBundle({ issue, spends: [], tickets: [ticket] }), {
    receiver: receiverFor(shop, { now: NOW + 100, attesters: [ATTESTER] }),
    db,
    limits: { maxPayment: 100_000_000n },
    transport: 'qr',
    request: null,
  })
  if (!outcome.accepted) throw new Error(String(outcome.reason))
  return { issue, outputId: outcome.note.outputId }
}

/** A note the payer issued to `middle`, who passed it on to the shop. */
async function receiveThroughAnotherHolder() {
  const middle = party(5)
  const issue = signIssue(payer, {
    issuer: payer.key,
    mint: MINT,
    lockSeq: 3,
    cumEnd: 5_000_000n,
    salt: new Uint8Array(16).fill(9),
    owner: { type: 'device', key: middle.key },
    amount: 5_000_000n,
    caveats: { expiry: NOW + 72 * 3600, hopsLeft: 3, flags: 0, scopeKind: 0, scope: new Uint8Array(20) },
  })
  const [input] = walkChain(NOTE_DOMAIN, issue, []).last
  const spend: Spend = {
    input: input.id,
    lockSeq: 4,
    salt: new Uint8Array(16).fill(3),
    outputs: {
      type: 'one',
      owner: { type: 'device', key: shop.key },
      caveats: { ...input.caveats, expiry: input.caveats.expiry - 3600, hopsLeft: 2 },
    },
  }
  const tickets = [
    makeTicket({
      device: payer.key,
      mint: MINT,
      lockSeq: 3,
      bond: 200_000_000n,
      backing: 100_000_000n,
      lockUntil: NOW + 30 * 86400,
    }),
    makeTicket({
      device: middle.key,
      mint: MINT,
      lockSeq: 4,
      bond: 200_000_000n,
      backing: 100_000_000n,
      lockUntil: NOW + 30 * 86400,
    }),
  ]
  const outcome = await acceptPayment(
    encodeBundle({ issue, spends: [{ message: spend, signature: signSpendWith(middle, input, spend) }], tickets }),
    {
      receiver: receiverFor(shop, { now: NOW + 100, attesters: [ATTESTER] }),
      db,
      limits: { maxPayment: 100_000_000n },
      transport: 'qr',
      request: null,
    },
  )
  if (!outcome.accepted) throw new Error(String(outcome.reason))
  return outcome.note.outputId
}

const stateOf = async (outputId: Uint8Array) =>
  (await db.all<{ state: string }>('SELECT state FROM received_note WHERE output_id = ?', [outputId]))[0].state

beforeEach(async () => {
  db = createNodeDb()
  await migrate(db)
  signer = createSoftSpendSigner(shop)
  sent = []
  answers = []
  claims = []
  claimed.length = 0
  clock = NOW + 1_000
  acknowledged = true
})

describe('settleHeld', () => {
  it('signs the settlement to the wallet account once and sends the same bytes on every retry', async () => {
    const { outputId } = await receive()
    answers = [
      () => Promise.reject(new Error('network down')),
      () => Promise.reject(new Error('network down')),
      async () => ({ signature: '5sig' }),
    ]
    const attempts = new Map<string, number>()
    for (let run = 0; run < 3; run++) {
      clock += 7 * 3600
      await settleHeld(deps({ attempts }))
    }
    expect(sent).toHaveLength(3)
    expect(new Set(sent.map((request) => request.spends.at(-1))).size).toBe(1)
    expect(signer.signatures).toBe(1)
    expect(await stateOf(outputId)).toBe('settled')
  })

  it('waits for the person to read who settling a note publishes, then settles it', async () => {
    const outputId = await receiveThroughAnotherHolder()
    let shown = false
    const report = await settleHeld(deps({ noticeShown: async () => shown }))
    expect(report).toMatchObject({ settled: 0, waiting: 1, notices: [{ holders: 1 }] })
    expect(report.notices[0].outputId).toEqual(outputId)
    expect(sent).toHaveLength(0)
    expect(signer.signatures).toBe(0)
    shown = true
    expect(await settleHeld(deps({ noticeShown: async () => shown }))).toMatchObject({ settled: 1, notices: [] })
    expect(await stateOf(outputId)).toBe('settled')
  })

  it('asks for no notice of a note paid straight from its issuer', async () => {
    await receive()
    expect(await settleHeld(deps({ noticeShown: async () => false }))).toMatchObject({ settled: 1, notices: [] })
  })

  it('leaves a note held when the device is locked and settles it after unlock', async () => {
    const { outputId } = await receive()
    const locked = Object.assign(new Error('locked'), { code: 'ERR_DEVICE_LOCKED' })
    expect(await settleHeld(deps({ signSpend: () => Promise.reject(locked) }))).toMatchObject({ waiting: 1 })
    expect(await stateOf(outputId)).toBe('held')
    expect(sent).toHaveLength(0)
    expect(await settleHeld(deps())).toMatchObject({ settled: 1 })
    expect(await stateOf(outputId)).toBe('settled')
  })

  it('signs the stored body after a failed attempt, never a new one', async () => {
    const { outputId } = await receive()
    const seen: Uint8Array[] = []
    const locked = Object.assign(new Error('locked'), { code: 'ERR_DEVICE_LOCKED' })
    await settleHeld(
      deps({
        signSpend: async (_input, spend) => {
          seen.push(spend.salt)
          throw locked
        },
      }),
    )
    const [stored] = await db.all<{ settlement_body: Uint8Array }>(
      'SELECT settlement_body FROM received_note WHERE output_id = ?',
      [outputId],
    )
    expect(stored.settlement_body).toBeInstanceOf(Uint8Array)
    await settleHeld(
      deps({
        signSpend: async (input, spend) => {
          seen.push(spend.salt)
          return signer.signSpend(input, spend)
        },
      }),
    )
    expect(seen).toHaveLength(2)
    expect(seen[1]).toEqual(seen[0])
  })

  it('sends nothing when the device signed another spend than the stored one', async () => {
    const { outputId } = await receive()
    const report = await settleHeld(
      deps({
        signSpend: (input, spend) => signer.signSpend(input, { ...spend, salt: new Uint8Array(16).fill(1) }),
      }),
    )
    expect(report).toMatchObject({ failed: 1, settled: 0 })
    expect(sent).toHaveLength(0)
    expect(await stateOf(outputId)).toBe('held')
  })

  it('marks a note settled on an answer and keeps the evidence of a conflict', async () => {
    const first = await receive()
    const second = await receive(10_000_000n)
    answers = [
      async () => ({ status: 'settled' }),
      () => Promise.reject(new GatewayError(409, 'conflict', { recorded: 'ab12' })),
    ]
    await settleHeld(deps())
    expect(await stateOf(first.outputId)).toBe('settled')
    expect(await stateOf(second.outputId)).toBe('conflicted')
    const evidence = await db.all<{ kind: string; existing: Uint8Array }>(
      'SELECT kind, existing FROM conflict_evidence',
    )
    expect(evidence).toHaveLength(1)
    expect(bytesToHex(evidence[0].existing)).toBe('ab12')
  })

  it('files the loss of a conflict with the chain it tried and reports whom it names', async () => {
    const { outputId } = await receive()
    answers = [() => Promise.reject(new GatewayError(409, 'conflict', { recorded: 'ab12' }))]
    claims = [
      async () => ({ state: 'filed', hop: 0, culprit: '02aa', lock: 'Lock1', burned: '80000000', signature: '5s' }),
    ]
    const report = await settleHeld(deps())
    expect(claimed).toEqual(sent)
    expect(report.lost).toEqual([
      {
        outputId,
        claim: { kind: 'reported', state: 'filed', hop: 0, culprit: '02aa', burned: 80_000_000n },
        steps: 2,
      },
    ])
  })

  it('waits with growing delays while the gateway is unreachable and never signs a second content', async () => {
    await receive()
    answers = Array.from({ length: 5 }, () => () => Promise.reject(new Error('network down')))
    const attempts = new Map<string, number>()
    const delays: number[] = []
    for (let run = 0; run < 5; run++) {
      delays.push((await settleHeld(deps({ attempts }))).retryIn ?? 0)
    }
    expect(delays).toEqual([30, 120, 600, 3600, 3600])
    expect(signer.signatures).toBe(1)
    expect(settlementDelay(0, () => 0)).toBe(24)
    expect(settlementDelay(0, () => 1)).toBe(36)
    expect(settlementDelay(9, () => 0.5)).toBe(3600)
  })

  it('does not start a settlement that cannot land before the window closes', async () => {
    const { outputId } = await receive()
    clock = NOW + 72 * 3600 + GRACE - 119
    expect(await settleHeld(deps())).toMatchObject({ settled: 0, waiting: 0 })
    expect(await stateOf(outputId)).toBe('expired')
    expect(signer.signatures).toBe(0)
    expect(sent).toHaveLength(0)
  })

  it('signs nothing until the label is acknowledged', async () => {
    const { outputId } = await receive()
    acknowledged = false
    expect(await settleHeld(deps())).toMatchObject({ blocked: 'label' })
    expect(signer.signatures).toBe(0)
    expect(await stateOf(outputId)).toBe('held')
    acknowledged = true
    expect(await settleHeld(deps())).toMatchObject({ settled: 1 })
  })

  it('reports a refusal the wallet can answer itself, and one with a time', async () => {
    const { outputId } = await receive()
    answers = [
      () => Promise.reject(new GatewayError(422, 'invalid', { selfPay: true })),
      () => Promise.reject(new GatewayError(409, 'horizon', { retryAt: clock + 7200 })),
    ]
    const first = await settleHeld(deps())
    expect(first.refused).toEqual([{ outputId, kind: 'invalid', selfPay: true }])
    const second = await settleHeld(deps())
    expect(second.refused).toEqual([{ outputId, kind: 'horizon', selfPay: false, retryAt: clock + 7200 }])
    expect(await stateOf(outputId)).toBe('settling')
  })

  it('never settles a note of another key', async () => {
    const { outputId } = await receive()
    await db.run("UPDATE received_note SET state = 'lost' WHERE output_id = ?", [outputId])
    expect(await settleHeld(deps())).toMatchObject({ settled: 0, waiting: 0, failed: 0 })
    expect(sent).toHaveLength(0)
  })

  it('settles the change of a note passed on by its own output, not the first output of the chain', async () => {
    const { issue } = await receive()
    const [held] = await heldOutputs(db, shop.key)
    const planned = planRespend(requestTo(party(9), 2_000_000n), [held], payCtx(shop))
    if (!planned.ok) throw new Error(planned.reason)
    const { plan } = planned
    const signed = await signer.signSpend(held.output, plan.spend)
    const bundle = chainOf(held, signed, plan.lock?.ticket ?? null)
    const messageId = paymentId(NOTE_DOMAIN, bundle)
    await prepareRespend(db, {
      input: held.outputId,
      messageId,
      body: encodeSpendBody(plan.spend),
      requestId: null,
      now: clock,
    })
    await markRespendSigned(db, {
      messageId,
      signature: signed.signature,
      bundle: encodeBundle(bundle),
      change: changeOf(NOTE_DOMAIN, bundle, plan.lock?.ticket ?? null, clock),
      now: clock,
    })
    await settleHeld(deps())
    const [request] = sent
    const spends = request.spends.map((hex) => decodeSpend(Uint8Array.from(Buffer.from(hex, 'hex'))))
    expect(spends).toHaveLength(2)
    expect(verifySettlement(NOTE_DOMAIN, PROGRAM, issue, spends).output.amount).toBe(3_000_000n)
  })

  it('sends the chain that verifySettlement accepts, ending in the wallet account', async () => {
    const { issue } = await receive()
    await settleHeld(deps())
    const [request] = sent
    expect(request.spends).toHaveLength(1)
    const spend = decodeSpend(Uint8Array.from(Buffer.from(request.spends[0], 'hex')))
    const settled = verifySettlement(NOTE_DOMAIN, PROGRAM, issue, [spend])
    expect(settled.output.owner).toEqual({ type: 'account', address: WALLET })
    expect(settled.output.amount).toBe(5_000_000n)
  })
})

const pointReceive = async (world: ReturnType<typeof eventWorld>, wire: Uint8Array) =>
  acceptPayment(wire, {
    receiver: receiverFor(world.organiser, { me: world.authority, now: NOW + 100, attesters: [ATTESTER] }),
    db,
    limits: { maxPayment: 100_000_000n },
    transport: 'nearby',
    request: null,
  })

describe('a point', () => {
  it('settles a chain that pays the organiser account as it was received, signing nothing', async () => {
    const world = eventWorld()
    const paid = world.payPoint(world.issueCredit(10_000_000n), 4_000_000n)
    const outcome = await pointReceive(world, paid.wire)
    if (!outcome.accepted) throw new Error(String(outcome.reason))
    const report = await settleHeld(deps({ me: party(7).key, wallet: world.pairing.authority }))
    expect(report).toMatchObject({ settled: 1, failed: 0 })
    expect(sent).toHaveLength(1)
    expect(sent[0].spends).toEqual(paid.bundle.spends.map((spend) => bytesToHex(encodeSpend(spend))))
  })

  it('keeps a note that pays the organiser account out of the lost notes of another key', async () => {
    const world = eventWorld()
    const paid = world.payPoint(world.issueCredit(10_000_000n), 4_000_000n)
    await pointReceive(world, paid.wire)
    await reconcileIdentity(db, party(8).key, NOW + 200)
    const [row] = await db.all<{ state: string }>('SELECT state FROM received_note')
    expect(row.state).toBe('held')
  })
})

describe('a phone without a connection', () => {
  const offline = () => Promise.reject(new Error('network down'))

  it('seals the note for a phone nearby once, and still tries again later', async () => {
    const { outputId } = await receive()
    answers = [offline, offline]
    const queueRelay = relayQueue(db, DEVNET_GENESIS_HASH, () => clock)
    const first = await settleHeld(deps({ queueRelay }))
    expect(first).toMatchObject({ settled: 0, waiting: 1 })
    const row = await outboxFor(db, bytesToHex(outputId))
    expect(row).toMatchObject({ kind: 'settle', storedBy: 0, answer: null, expiresAt: NOW + 72 * 3600 + GRACE })
    const inner = parseInner(await openAsGateway(row!.blob, 'relay'))
    expect(inner.issue.length).toBeGreaterThan(0)
    expect(inner.spends.length).toBeGreaterThanOrEqual(1)
    await settleHeld(deps({ queueRelay }))
    expect(await db.all('SELECT id FROM relay_outbox')).toHaveLength(1)
  })

  it('queues nothing when the gateway answered, and settles as before', async () => {
    await receive()
    const report = await settleHeld(deps({ queueRelay: relayQueue(db, DEVNET_GENESIS_HASH, () => clock) }))
    expect(report.settled).toBe(1)
    expect(await db.all('SELECT id FROM relay_outbox')).toEqual([])
  })

  it('goes on waiting when no key is left to seal to', async () => {
    await receive()
    answers = [offline]
    clock = NOW + 400 * 86_400
    const report = await settleHeld(deps({ queueRelay: relayQueue(db, DEVNET_GENESIS_HASH, () => clock) }))
    expect(report.settled).toBe(0)
    expect(await db.all('SELECT id FROM relay_outbox')).toEqual([])
  })
})
