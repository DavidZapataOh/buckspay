import { p256 } from '@noble/curves/nist.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import vectors from '../../anchor/crates/protocol/tests/vectors/v1.json'
import {
  type Caveats,
  checkSpendStep,
  content,
  decodeBondTicket,
  decodeIssue,
  decodeIssueConflict,
  decodeOwner,
  decodeSpend,
  decodeSpendConflict,
  DEVNET_GENESIS_HASH,
  domain,
  encodeBondTicket,
  encodeIssue,
  encodeIssueConflict,
  encodeOwner,
  encodeSpend,
  encodeSpendConflict,
  envelope,
  GRACE,
  Kind,
  MAINNET_GENESIS_HASH,
  messageId,
  NO_LOCK,
  type Output,
  type Outputs,
  outputId,
  Purpose,
  ScopeKind,
  type Issue,
  type Received,
  type Receiver,
  scopeHash,
  type Settled,
  type Signed,
  type Spend,
  recoverIssueSigner,
  recoverSpendSigner,
  ticketMessage,
  verifyIssueConflict,
  verifyPayment,
  verifySettlement,
  verifySpendConflict,
} from '.'

const NOTE_DOMAIN = hexToBytes(vectors.domain.note)
const decodeSpends = (spends: string[]) => spends.map((spend) => decodeSpend(hexToBytes(spend)))
const decodeTickets = (tickets: string[]) => tickets.map((ticket) => decodeBondTicket(hexToBytes(ticket)))
const expectSettled = (settled: Settled, result: NonNullable<(typeof vectors.settlements)[number]['result']>) => {
  expect(bytesToHex(settled.output.id)).toBe(result.output_id)
  expect(bytesToHex(encodeOwner(settled.output.owner))).toBe(result.owner)
  expect(settled.output.amount).toBe(BigInt(result.amount))
  expect(bytesToHex(settled.mint)).toBe(result.mint)
  expect(bytesToHex(settled.issuer)).toBe(result.issuer)
  expect(settled.lockSeq).toBe(result.lock_seq)
}
const expectReceived = (received: Received, result: (typeof vectors.payments)[number]['result']) => {
  expectSettled(received, result)
  const liable = received.liable.map(({ device, lockSeq, bond }) => ({
    device: bytesToHex(device),
    lock_seq: lockSeq,
    bond: bond.toString(),
  }))
  expect(liable).toEqual(result.liable)
}
type ReceiverVector = {
  me: string
  now: number
  min_window: number
  accept_category: boolean
  accept_authorities: string[]
}
const receiver = (vector: ReceiverVector): Receiver => ({
  noteDomain: NOTE_DOMAIN,
  ticketDomain: hexToBytes(vectors.domain.ticket),
  attesters: vectors.attesters.map(({ id, public: key }) => ({ id, key: hexToBytes(key) })),
  me: decodeOwner(hexToBytes(vector.me)),
  now: vector.now,
  minWindow: vector.min_window,
  acceptCategory: vector.accept_category,
  acceptAuthorities: vector.accept_authorities.map(hexToBytes),
})

describe('clusters and domains', () => {
  it('pins the cluster genesis hashes', () => {
    expect(bytesToHex(DEVNET_GENESIS_HASH)).toBe(vectors.clusters.devnet)
    expect(bytesToHex(MAINNET_GENESIS_HASH)).toBe(vectors.clusters.mainnet)
  })

  for (const purpose of Object.values(Purpose)) {
    it(`derives the ${purpose} domain like Rust`, () => {
      const genesisHash = hexToBytes(vectors.domain.genesis_hash)
      const derived = domain(purpose, genesisHash, hexToBytes(vectors.domain.program_id))
      expect(bytesToHex(derived)).toBe(vectors.domain[purpose])
    })
  }
})

describe('messages', () => {
  for (const vector of vectors.messages) {
    it(`${vector.name} round-trips byte for byte`, () => {
      const wire = hexToBytes(vector.wire)
      const encoded = vector.kind === Kind.Issue ? encodeIssue(decodeIssue(wire)) : encodeSpend(decodeSpend(wire))
      expect(bytesToHex(encoded)).toBe(vector.wire)
    })

    it(`${vector.name} derives the same identifiers`, () => {
      const env = envelope(NOTE_DOMAIN, hexToBytes(vector.slot), hexToBytes(vector.content))
      expect(bytesToHex(env)).toBe(vector.envelope)
      const id = messageId(env)
      expect(bytesToHex(id)).toBe(vector.message_id)
      vector.output_ids.forEach((expected, index) => expect(bytesToHex(outputId(id, index))).toBe(expected))
    })
  }

  for (const vector of vectors.tickets) {
    it(`${vector.name} round-trips and signs the same bytes`, () => {
      const ticket = decodeBondTicket(hexToBytes(vector.wire))
      expect(bytesToHex(encodeBondTicket(ticket))).toBe(vector.wire)
      expect(bytesToHex(ticketMessage(hexToBytes(vectors.domain.ticket), ticket))).toBe(vector.signed_message)
    })
  }

  it('hashes content with SHA-256', () => {
    expect(bytesToHex(content(new TextEncoder().encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('payments', () => {
  for (const vector of vectors.payments) {
    it(`${vector.name} is received like in Rust`, () => {
      const issue = decodeIssue(hexToBytes(vector.issue))
      const received = verifyPayment(
        receiver(vector),
        issue,
        decodeSpends(vector.spends),
        decodeTickets(vector.tickets),
      )
      expectReceived(received, vector.result)
    })
  }

  for (const vector of vectors.invalid) {
    it(`${vector.name} fails with ${vector.error}`, () => {
      const wire = hexToBytes(vector.wire)
      const run = () =>
        vector.kind === Kind.Issue
          ? verifyPayment(
              receiver(vector),
              decodeIssue(wire),
              decodeSpends(vector.spends),
              decodeTickets(vector.tickets),
            )
          : decodeSpend(wire)
      expect(run).toThrow(expect.objectContaining({ name: 'ProtocolError', code: vector.error }))
    })
  }

  it('rejects times, indices and owners that do not fit their width', () => {
    const [vector] = vectors.payments
    const pay = (now: number, minWindow: number) =>
      verifyPayment(
        { ...receiver(vector), now, minWindow },
        decodeIssue(hexToBytes(vector.issue)),
        decodeSpends(vector.spends),
        decodeTickets(vector.tickets),
      )
    expect(pay(vector.now, vector.min_window).output.amount).toBe(BigInt(vector.result.amount))
    for (const [now, minWindow] of [
      [-1, vector.min_window],
      [vector.now, -vector.now],
      [vector.now + 0.5, vector.min_window],
      [2 ** 32, vector.min_window],
      [vector.now, Number.NaN],
    ]) {
      expect(() => pay(now, minWindow)).toThrow(expect.objectContaining({ name: 'ProtocolError', code: 'Length' }))
    }
    expect(() => outputId(new Uint8Array(32), 256)).toThrow(expect.objectContaining({ code: 'Length' }))
    expect(() => decodeOwner(new Uint8Array(32))).toThrow(expect.objectContaining({ code: 'Length' }))
  })

  it('rejects byte fields that do not fit their width', () => {
    const [vector] = vectors.payments
    const base = receiver(vector)
    const issue = decodeIssue(hexToBytes(vector.issue))
    const [toBob, toCarol] = decodeSpends(vector.spends)
    const tickets = decodeTickets(vector.tickets)
    const pay = (changed: { receiver?: Receiver; issue?: Signed<Issue>; spend?: Signed<Spend> }) => () =>
      verifyPayment(changed.receiver ?? base, changed.issue ?? issue, [toBob, changed.spend ?? toCarol], tickets)
    const withIssue = (fields: Partial<Issue>) => pay({ issue: { ...issue, message: { ...issue.message, ...fields } } })
    const withSpend = (fields: Partial<Spend>) =>
      pay({ spend: { ...toCarol, message: { ...toCarol.message, ...fields } } })
    const { message } = issue
    const carol = toCarol.message.outputs
    if (message.owner.type !== 'device' || carol.type !== 'one') throw new Error('unexpected vector')
    const attendee = vectors.payments.find((payment) => payment.name === 'authority_note_to_trusted_attendee')!
    const organiser = { type: 'account', address: new Uint8Array(32).fill(0xa0) } as const
    for (const resize of [
      (bytes: Uint8Array) => bytes.subarray(1),
      (bytes: Uint8Array) => Uint8Array.of(...bytes, 0),
    ]) {
      const cases = {
        'issue signature': pay({ issue: { ...issue, signature: resize(issue.signature) } }),
        issuer: withIssue({ issuer: resize(message.issuer) }),
        'device owner': withIssue({ owner: { type: 'device', key: resize(message.owner.key) } }),
        mint: withIssue({ mint: resize(message.mint) }),
        'issue salt': withIssue({ salt: resize(message.salt) }),
        scope: withIssue({ caveats: { ...message.caveats, scope: resize(message.caveats.scope) } }),
        input: withSpend({ input: resize(toCarol.message.input) }),
        'spend salt': withSpend({ salt: resize(toCarol.message.salt) }),
        'account owner': withSpend({
          outputs: { ...carol, owner: { ...organiser, address: resize(organiser.address) } },
        }),
        'spend signature': pay({ spend: { ...toCarol, signature: resize(toCarol.signature) } }),
        me: pay({ receiver: { ...base, me: { type: 'device', key: resize(message.owner.key) } } }),
        'trusted authority': () =>
          verifyPayment(
            { ...receiver(attendee), acceptAuthorities: [resize(organiser.address)] },
            decodeIssue(hexToBytes(attendee.issue)),
            [],
            decodeTickets(attendee.tickets),
          ),
      }
      for (const [field, run] of Object.entries(cases)) {
        expect(run, field).toThrow(expect.objectContaining({ name: 'ProtocolError', code: 'Length' }))
      }
    }
  })

  it('trusts an authority by its account address, never by a scope hash', () => {
    const vector = vectors.payments.find((payment) => payment.name === 'authority_note_to_trusted_attendee')!
    const pay = (acceptAuthorities: Uint8Array[]) => () =>
      verifyPayment(
        { ...receiver(vector), acceptAuthorities },
        decodeIssue(hexToBytes(vector.issue)),
        [],
        decodeTickets(vector.tickets),
      )
    const organiser = new Uint8Array(32).fill(0xa0)
    expect(pay([organiser])().output.amount).toBe(BigInt(vector.result.amount))
    expect(pay([scopeHash({ type: 'account', address: organiser })])).toThrow(
      expect.objectContaining({ name: 'ProtocolError', code: 'Length' }),
    )
  })
})

describe('settlements', () => {
  for (const vector of vectors.settlements) {
    const { result, error } = vector
    it(`${vector.name} ${result ? 'settles like in Rust' : `fails with ${error}`}`, () => {
      const settle = () =>
        verifySettlement(NOTE_DOMAIN, decodeIssue(hexToBytes(vector.issue)), decodeSpends(vector.spends))
      if (result) {
        expectSettled(settle(), result)
      } else {
        expect(settle).toThrow(expect.objectContaining({ name: 'ProtocolError', code: error }))
      }
    })
  }
})

describe('conflicts', () => {
  for (const vector of vectors.conflicts) {
    it(`${vector.name} ${vector.error ? `fails with ${vector.error}` : 'is proven'}`, () => {
      const wire = hexToBytes(vector.wire)
      const check =
        wire[1] === Kind.SpendConflict
          ? () => {
              const conflict = decodeSpendConflict(wire)
              expect(bytesToHex(encodeSpendConflict(conflict))).toBe(vector.wire)
              const signer = recoverSpendSigner(NOTE_DOMAIN, conflict)
              expect(bytesToHex(signer)).toBe(vector.signer)
              verifySpendConflict(NOTE_DOMAIN, signer, conflict)
            }
          : () => {
              const conflict = decodeIssueConflict(wire)
              expect(bytesToHex(encodeIssueConflict(conflict))).toBe(vector.wire)
              const signer = recoverIssueSigner(NOTE_DOMAIN, conflict)
              expect(bytesToHex(signer)).toBe(vector.signer)
              verifyIssueConflict(NOTE_DOMAIN, signer, conflict)
            }
      if (vector.error) {
        expect(check).toThrow(expect.objectContaining({ name: 'ProtocolError', code: vector.error }))
      } else {
        expect(check).not.toThrow()
      }
    })
  }
})

describe('spend steps', () => {
  it('checks a spend against its input before it is signed, like Rust', () => {
    const NOW = 1_800_000_000
    const EXPIRY = 1_900_000_000
    const [alice, bob] = [2, 3].map((secret) => ({
      type: 'device' as const,
      key: p256.getPublicKey(new Uint8Array(32).fill(secret)),
    }))
    const account = { type: 'account' as const, address: new Uint8Array(32).fill(0xb5) }
    const caveats = (hopsLeft: number): Caveats => ({
      expiry: EXPIRY,
      hopsLeft,
      flags: 0,
      scopeKind: ScopeKind.Any,
      scope: new Uint8Array(20),
    })
    const input: Output = { id: new Uint8Array(32).fill(7), owner: alice, amount: 20_000n, caveats: caveats(4) }
    const spend = (lockSeq: number, outputs: Outputs): Spend => ({
      input: input.id,
      lockSeq,
      salt: new Uint8Array(16).fill(6),
      outputs,
    })
    const pay = (hopsLeft: number): Outputs => ({ type: 'one', owner: bob, caveats: caveats(hopsLeft) })
    const split = (amount0: bigint, owner1: typeof alice): Outputs => ({
      type: 'two',
      owner0: bob,
      amount0,
      caveats0: caveats(3),
      owner1,
    })
    const settle = spend(NO_LOCK, { type: 'one', owner: account, caveats: caveats(3) })
    const check = (step: Spend, now: number, from = input) => {
      return () => checkSpendStep(from, step, now)
    }
    const fails = (code: string) => expect.objectContaining({ name: 'ProtocolError', code })

    expect(check(spend(0, pay(3)), NOW)).not.toThrow()
    expect(check(spend(0, split(12_000n, alice)), NOW)).not.toThrow()
    expect(check(spend(0, split(20_000n, alice)), NOW)).toThrow(fails('Amount'))
    expect(check(spend(0, split(12_000n, bob)), NOW)).toThrow(fails('Change'))
    expect(check(spend(0, pay(4)), NOW)).toThrow(fails('Attenuation'))
    expect(check(spend(NO_LOCK, pay(3)), NOW)).toThrow(fails('Lock'))
    expect(check({ ...spend(0, pay(3)), input: new Uint8Array(32).fill(8) }, NOW)).toThrow(fails('Linkage'))
    expect(check(spend(0, pay(3)), EXPIRY)).not.toThrow()
    expect(check(spend(0, pay(3)), EXPIRY + 1)).toThrow(fails('Expired'))
    expect(check(settle, EXPIRY + GRACE)).not.toThrow()
    expect(check(settle, EXPIRY + GRACE + 1)).toThrow(fails('Expired'))
    expect(check(spend(0, split(12_000n, alice)), NOW, { ...input, caveats: caveats(1) })).toThrow(fails('Depth'))
    expect(check(settle, NOW, { ...input, owner: account })).toThrow(fails('Owner'))
    expect(check(settle, -1)).toThrow(fails('Length'))
  })
})
