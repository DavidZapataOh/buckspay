import { describe, expect, it, vi } from 'vitest'
import {
  CHANNEL_ULTRASOUND,
  decodeChallengeMessage,
  decodeEvidence,
  decodeResponseMessage,
  encodeChallengeMessage,
  encodeResponseMessage,
  verifyWitness,
  type WitnessBody,
} from '../../protocol'
import { type Modem, type PayerDeps, runPayer, runReceiver, type SessionDeps, type WitnessConfig } from './session'
import { createRoom, FAST, PAYMENT_ID, party, realClock, softSigner, WITNESS_DOMAIN } from './testing/world'

const payer = party(1)
const shop = party(2)
const facts = { payerKey: payer.key, receiverKey: shop.key }
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n))

const base = (modem: Modem, config: WitnessConfig = FAST): SessionDeps => ({
  modem,
  clock: realClock,
  random,
  config,
  witnessDomain: WITNESS_DOMAIN,
  channel: CHANNEL_ULTRASOUND,
})

function payerDeps(modem: Modem, over: Partial<PayerDeps> = {}): PayerDeps {
  let signed = 0
  return {
    ...base(modem),
    sign: softSigner(payer),
    countSignature: async () => ++signed,
    ...over,
  }
}

const run = (room: ReturnType<typeof createRoom>, over: Partial<PayerDeps> = {}, config: WitnessConfig = FAST) => {
  const [a, b] = room
  const signal = new AbortController().signal
  return Promise.all([
    runReceiver(PAYMENT_ID, facts, base(a, config), signal),
    runPayer(PAYMENT_ID, facts, payerDeps(b, over), signal),
  ])
}

describe('the exchange', () => {
  it('ends with evidence on the receiver that verifies and a seen status on both', async () => {
    const [receiver, answerer] = await run(createRoom())
    expect(receiver.status).toBe('seen')
    expect(answerer.status).toBe('seen')
    const evidence = decodeEvidence(receiver.evidence!)
    expect(() => verifyWitness(WITNESS_DOMAIN, evidence)).not.toThrow()
    expect(evidence.paymentId).toEqual(PAYMENT_ID)
    expect(evidence.payerKey).toEqual(payer.key)
    expect(evidence.receiverKey).toEqual(shop.key)
    expect(evidence.channel).toBe(CHANNEL_ULTRASOUND)
    expect(decodeEvidence(answerer.evidence!)).toEqual(evidence)
  })

  it('puts a 17-byte challenge and a 65-byte response on the air, nothing else', async () => {
    const room = createRoom()
    await run(room)
    expect(room[0].played.map((p) => p.length)).toEqual([17])
    expect(room[1].played.map((p) => p.length)).toEqual([65])
  })

  it('uses a fresh challenge for every attempt', async () => {
    const first = createRoom()
    const second = createRoom()
    await run(first)
    await run(second)
    expect(first[0].played[0].slice(1, 9)).not.toEqual(second[0].played[0].slice(1, 9))
  })

  it('is not seen when the payer never answers, after the receiver budget', async () => {
    const [a] = createRoom()
    const started = Date.now()
    const result = await runReceiver(PAYMENT_ID, facts, base(a), new AbortController().signal)
    expect(result).toEqual({ status: 'not-seen' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(FAST.receiverBudgetMs)
  })

  it('repeats the same challenge until an answer comes, and the answer to a repeat is accepted', async () => {
    const room = createRoom({ drop: (_, payload) => payload.length === 65 && !dropped.has('x') && !!dropped.add('x') })
    const dropped = new Set<string>()
    const [receiver] = await run(room)
    expect(receiver.status).toBe('seen')
    const challenges = room[0].played.map((p) => p.slice(1, 9).toString())
    expect(room[0].played.length).toBeGreaterThanOrEqual(2)
    expect(new Set(challenges).size).toBe(1)
  })

  it('answers a repeated challenge from memory without a second signature', async () => {
    const dropped = new Set<number>()
    const room = createRoom({ drop: (_, p) => p.length === 65 && dropped.size === 0 && !!dropped.add(1) })
    const sign = vi.fn(softSigner(payer))
    await run(room, { sign })
    expect(sign).toHaveBeenCalledTimes(1)
    expect(room[1].played.length).toBeGreaterThanOrEqual(2)
  })

  it('ignores what the phone hears of its own playback', async () => {
    const room = createRoom({ echo: true })
    const [receiver, answerer] = await run(room)
    expect(receiver.status).toBe('seen')
    expect(answerer.status).toBe('seen')
  })
})

describe('the receiver refuses', () => {
  const answerWith = async (modemOfAttacker: Modem, wire: Uint8Array) => {
    await modemOfAttacker.emit(wire)
  }

  it('an answer signed by another key', async () => {
    const [a, b] = createRoom()
    const pending = runReceiver(PAYMENT_ID, facts, base(a), new AbortController().signal)
    await new Promise((r) => setTimeout(r, 30))
    const heard = decodeChallengeMessage(PAYMENT_ID, a.played[0])!
    const forged: WitnessBody = {
      paymentId: PAYMENT_ID,
      ...facts,
      challenge: heard.challenge,
      issuedAt: heard.issuedAt,
      channel: 1,
    }
    await answerWith(b, encodeResponseMessage(await softSigner(party(9))(forged)))
    expect((await pending).status).toBe('not-seen')
  })

  it('an answer to another challenge, even a genuine one signed by the payer', async () => {
    const [a, b] = createRoom()
    const pending = runReceiver(PAYMENT_ID, facts, base(a), new AbortController().signal)
    await new Promise((r) => setTimeout(r, 30))
    const old: WitnessBody = {
      paymentId: PAYMENT_ID,
      ...facts,
      challenge: new Uint8Array(8).fill(1),
      issuedAt: 1_700_000_000,
      channel: 1,
    }
    await answerWith(b, encodeResponseMessage(await softSigner(payer)(old)))
    expect((await pending).status).toBe('not-seen')
  })

  it('an answer for another payment', async () => {
    const [a, b] = createRoom()
    const pending = runReceiver(PAYMENT_ID, facts, base(a), new AbortController().signal)
    await new Promise((r) => setTimeout(r, 30))
    const heard = decodeChallengeMessage(PAYMENT_ID, a.played[0])!
    const other: WitnessBody = {
      paymentId: new Uint8Array(32).fill(1),
      ...facts,
      challenge: heard.challenge,
      issuedAt: heard.issuedAt,
      channel: 1,
    }
    await answerWith(b, encodeResponseMessage(await softSigner(payer)(other)))
    expect((await pending).status).toBe('not-seen')
  })

  it('checks at most three answers, however many arrive', async () => {
    const [a, b] = createRoom()
    const pending = runReceiver(PAYMENT_ID, facts, base(a), new AbortController().signal)
    await new Promise((r) => setTimeout(r, 30))
    const heard = decodeChallengeMessage(PAYMENT_ID, a.played[0])!
    const real: WitnessBody = {
      paymentId: PAYMENT_ID,
      ...facts,
      challenge: heard.challenge,
      issuedAt: heard.issuedAt,
      channel: 1,
    }
    for (let i = 0; i < 3; i++) await answerWith(b, encodeResponseMessage(new Uint8Array(64).fill(i + 1)))
    await answerWith(b, encodeResponseMessage(await softSigner(payer)(real)))
    expect((await pending).status).toBe('not-seen')
  })

  it('an answer heard while it is still playing its own challenge', async () => {
    let onMessage: (payload: Uint8Array) => void = () => {}
    let endPlayback: () => void = () => {}
    const played: Uint8Array[] = []
    const modem: Modem = {
      check: async () => ({ ready: true }),
      listen: async (listener) => {
        onMessage = listener
        return async () => {}
      },
      emit: (payload) => {
        played.push(payload)
        return played.length > 1 ? Promise.resolve() : new Promise((resolve) => (endPlayback = resolve))
      },
    }
    const pending = runReceiver(PAYMENT_ID, facts, base(modem), new AbortController().signal)
    await new Promise((r) => setTimeout(r, 20))
    const heard = decodeChallengeMessage(PAYMENT_ID, played[0])!
    const body: WitnessBody = {
      paymentId: PAYMENT_ID,
      ...facts,
      challenge: heard.challenge,
      issuedAt: heard.issuedAt,
      channel: 1,
    }
    onMessage(encodeResponseMessage(await softSigner(payer)(body)))
    endPlayback()
    expect((await pending).status).toBe('not-seen')
  })

  it('anything that is not an answer', async () => {
    const [a, b] = createRoom()
    const pending = runReceiver(PAYMENT_ID, facts, base(a), new AbortController().signal)
    await new Promise((r) => setTimeout(r, 30))
    await answerWith(b, new Uint8Array(65).fill(0x12).fill(0x13, 0, 1))
    await answerWith(b, new Uint8Array(10))
    expect((await pending).status).toBe('not-seen')
  })

  it('is unavailable, not not-seen, when the microphone was silenced and nothing was heard', async () => {
    const [a] = createRoom()
    const silenced: Modem = { ...a, silenced: () => true }
    expect(await runReceiver(PAYMENT_ID, facts, base(silenced), new AbortController().signal)).toEqual({
      status: 'unavailable',
    })
  })

  it('is low-volume, not not-seen, when nothing was heard and the volume is low', async () => {
    const [a] = createRoom()
    const quiet: Modem = { ...a, check: async () => ({ ready: true, volumeLow: true }) }
    expect(await runReceiver(PAYMENT_ID, facts, base(quiet), new AbortController().signal)).toEqual({
      status: 'low-volume',
    })
  })

  it('is still seen when the volume is low but the other phone answered', async () => {
    const [a, b] = createRoom()
    const quiet: Modem = { ...a, check: async () => ({ ready: true, volumeLow: true }) }
    const signal = new AbortController().signal
    const [receiver] = await Promise.all([
      runReceiver(PAYMENT_ID, facts, base(quiet), signal),
      runPayer(PAYMENT_ID, facts, payerDeps(b), signal),
    ])
    expect(receiver.status).toBe('seen')
  })

  it('is unavailable without a microphone permission, and plays nothing', async () => {
    const [a] = createRoom()
    const denied: Modem = { ...a, check: async () => ({ ready: false, reason: 'permission-denied' }) }
    expect(await runReceiver(PAYMENT_ID, facts, base(denied), new AbortController().signal)).toEqual({
      status: 'unavailable',
    })
    expect(a.played).toHaveLength(0)
  })

  it('stops at once when cancelled', async () => {
    const [a] = createRoom()
    const abort = new AbortController()
    const started = Date.now()
    const pending = runReceiver(PAYMENT_ID, facts, base(a), abort.signal)
    setTimeout(() => abort.abort(), 40)
    expect((await pending).status).toBe('not-seen')
    expect(Date.now() - started).toBeLessThan(FAST.receiverBudgetMs)
  })
})

describe('the payer refuses', () => {
  const challengeAt = (issuedAt: number, id = PAYMENT_ID) =>
    encodeChallengeMessage(id, { challenge: new Uint8Array(8).fill(7), issuedAt })
  const hear = async (wire: Uint8Array, over: Partial<PayerDeps> = {}) => {
    const [a, b] = createRoom()
    const sign = vi.fn(softSigner(payer))
    const pending = runPayer(PAYMENT_ID, facts, payerDeps(b, { sign, ...over }), new AbortController().signal)
    await new Promise((r) => setTimeout(r, 20))
    await a.emit(wire)
    const result = await pending
    return { result, sign, played: b.played }
  }

  it('to sign anything for a challenge made by someone who does not know the payment id', async () => {
    const { result, sign, played } = await hear(challengeAt(Math.floor(Date.now() / 1000), new Uint8Array(32).fill(1)))
    expect(result.status).toBe('not-seen')
    expect(sign).not.toHaveBeenCalled()
    expect(played).toHaveLength(0)
  })

  it('a challenge from the past or the future beyond the clock tolerance', async () => {
    const now = Math.floor(Date.now() / 1000)
    for (const issuedAt of [now - 125, now + 125]) {
      const { sign } = await hear(challengeAt(issuedAt))
      expect(sign).not.toHaveBeenCalled()
    }
    const { sign } = await hear(challengeAt(now - 100))
    expect(sign).toHaveBeenCalledTimes(1)
  })

  it('more than three signatures for one payment', async () => {
    const [a, b] = createRoom()
    const sign = vi.fn(softSigner(payer))
    let count = 0
    const pending = runPayer(
      PAYMENT_ID,
      facts,
      payerDeps(b, { sign, countSignature: async () => ++count }),
      new AbortController().signal,
    )
    await new Promise((r) => setTimeout(r, 20))
    const now = Math.floor(Date.now() / 1000)
    for (let i = 1; i <= 5; i++) {
      await a.emit(encodeChallengeMessage(PAYMENT_ID, { challenge: new Uint8Array(8).fill(i), issuedAt: now }))
      await new Promise((r) => setTimeout(r, 30))
    }
    await pending
    expect(sign).toHaveBeenCalledTimes(3)
  })

  it('signs only a body built from what it holds: its own payment, its own key and the receiver it paid', async () => {
    const seen: WitnessBody[] = []
    const { result } = await hear(challengeAt(Math.floor(Date.now() / 1000)), {
      sign: async (body) => {
        seen.push(body)
        return softSigner(payer)(body)
      },
    })
    expect(result.status).toBe('seen')
    expect(seen).toHaveLength(1)
    expect(seen[0].paymentId).toEqual(PAYMENT_ID)
    expect(seen[0].payerKey).toEqual(payer.key)
    expect(seen[0].receiverKey).toEqual(shop.key)
  })

  it('is unavailable, not not-seen, when the microphone was silenced and nothing was heard', async () => {
    const [, b] = createRoom()
    const silenced: Modem = { ...b, silenced: () => true }
    expect(await runPayer(PAYMENT_ID, facts, payerDeps(silenced), new AbortController().signal)).toEqual({
      status: 'unavailable',
    })
  })

  it('is unavailable without a microphone permission', async () => {
    const [, b] = createRoom()
    const denied: Modem = { ...b, check: async () => ({ ready: false, reason: 'permission-denied' }) }
    expect(await runPayer(PAYMENT_ID, facts, payerDeps(denied), new AbortController().signal)).toEqual({
      status: 'unavailable',
    })
  })

  it('leaves the answer to a damaged response alone', () => {
    expect(decodeResponseMessage(challengeAt(1))).toBeNull()
  })
})
