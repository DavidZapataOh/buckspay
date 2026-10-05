import { ed25519 } from '@noble/curves/ed25519.js'
import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import vectors from '../../anchor/crates/protocol/tests/vectors/v1.json'
import {
  CLAIM_SEED,
  claimAddress,
  isRecordable,
  type BondTicket,
  type Caveats,
  TICKET_TTL_MAX,
  checkIssueStep,
  checkSpendStep,
  content,
  decodeBondTicket,
  decodeIssue,
  decodeIssueConflict,
  decodeOwner,
  decodeSpend,
  decodeSpendConflict,
  deviceBindingBody,
  deviceBindingEnvelope,
  deviceRotationBody,
  deviceRotationEnvelope,
  DEVNET_GENESIS_HASH,
  domain,
  encodeBondTicket,
  encodeIssue,
  encodeIssueConflict,
  encodeOwner,
  encodeSpend,
  encodeSpendBody,
  encodeSpendConflict,
  envelope,
  EXPIRY_STEP,
  CHALLENGE,
  GRACE,
  Kind,
  MAINNET_GENESIS_HASH,
  messageId,
  NO_LOCK,
  type Output,
  type Outputs,
  outputId,
  Purpose,
  reclaimBody,
  reclaimEnvelope,
  recordAddress,
  recordContent,
  RECORD_BUMP,
  ScopeKind,
  writeVerification,
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
  verifySignature,
  verifySpendConflict,
  walkChain,
} from '.'

const NOTE_DOMAIN = hexToBytes(vectors.domain.note)
const PROGRAM = hexToBytes(vectors.record_addresses.program_id)
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
  program: PROGRAM,
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
        verifySettlement(NOTE_DOMAIN, PROGRAM, decodeIssue(hexToBytes(vector.issue)), decodeSpends(vector.spends))
      if (result) {
        expectSettled(settle(), result)
      } else {
        expect(settle).toThrow(expect.objectContaining({ name: 'ProtocolError', code: error }))
      }
    })
  }
})

describe('walking a chain', () => {
  const vector = vectors.settlements.find((settlement) => settlement.name === 'unbonded_receiver_settles')!
  const issue = decodeIssue(hexToBytes(vector.issue))
  const spends = decodeSpends(vector.spends)

  it('lays out the messages, the links and the consumed outputs the way the program reads them', () => {
    const walk = walkChain(NOTE_DOMAIN, issue, spends)
    const [issued, toBob] = vectors.messages
    expect(walk.entries.map(({ envelope }) => bytesToHex(envelope)).slice(0, 2)).toEqual([
      issued.envelope,
      toBob.envelope,
    ])
    expect(bytesToHex(walk.entries[0].key)).toBe(bytesToHex(issue.message.issuer))
    expect(walk.entries.map(({ signature }) => bytesToHex(signature))).toEqual([
      bytesToHex(issue.signature),
      ...spends.map(({ signature }) => bytesToHex(signature)),
    ])
    expect(walk.links.map(({ input }) => input)).toEqual([0, 0])
    expect(walk.consumed.map(({ output }) => bytesToHex(output))).toEqual([issued.output_ids[0], toBob.output_ids[0]])
    expect(walk.consumed.map(({ content: spent }) => bytesToHex(spent))).toEqual(
      walk.links.map(({ body }) => bytesToHex(content(body))),
    )
    expect(walk.links.map(({ body }) => bytesToHex(body))).toEqual(
      spends.map((spend) => bytesToHex(encodeSpend(spend).subarray(32, -64))),
    )
    expect(bytesToHex(walk.last[0].id)).toBe(vector.result!.output_id)
  })

  it('takes the change of a message as the next input, and refuses an input nothing created', () => {
    const [toBob, toCarol] = decodeSpends(vectors.payments[1].spends)
    const change = walkChain(NOTE_DOMAIN, decodeIssue(hexToBytes(vectors.payments[1].issue)), [toBob, toCarol])
    expect(change.links.map(({ input }) => input)).toEqual([0, 1])
    const stray = { ...toBob, message: { ...toBob.message, input: new Uint8Array(32) } }
    expect(() => walkChain(NOTE_DOMAIN, issue, [stray])).toThrow(expect.objectContaining({ code: 'Linkage' }))
  })
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

describe('device bindings', () => {
  const DEVICE_DOMAIN = hexToBytes(vectors.domain.device)
  for (const vector of vectors.device_bindings) {
    it(`${vector.name} ${vector.error ? `fails with ${vector.error}` : 'matches Rust'}`, () => {
      const wallet = hexToBytes(vector.wallet)
      const key = hexToBytes(vector.device)
      if (vector.error) {
        expect(() => deviceBindingEnvelope(DEVICE_DOMAIN, wallet, key)).toThrow(
          expect.objectContaining({ name: 'ProtocolError', code: vector.error }),
        )
        return
      }
      expect(bytesToHex(deviceBindingBody(wallet, key))).toBe(vector.body)
      const message = deviceBindingEnvelope(DEVICE_DOMAIN, wallet, key)
      expect(bytesToHex(message)).toBe(vector.envelope)
      verifySignature(key, message, hexToBytes(vector.signature))
    })
  }

  it('rejects a wallet or key of the wrong width', () => {
    const [vector] = vectors.device_bindings
    const wallet = hexToBytes(vector.wallet)
    const key = hexToBytes(vector.device)
    const length = expect.objectContaining({ name: 'ProtocolError', code: 'Length' })
    expect(() => deviceBindingBody(wallet.subarray(1), key)).toThrow(length)
    expect(() => deviceBindingBody(wallet, key.subarray(1))).toThrow(length)
  })
})

describe('device rotations', () => {
  const DEVICE_DOMAIN = hexToBytes(vectors.domain.device)
  for (const vector of vectors.device_rotations) {
    it(`${vector.name} ${vector.error ? `fails with ${vector.error}` : 'matches Rust'}`, () => {
      const [oldWallet, newWallet] = [vector.old_wallet, vector.new_wallet].map((wallet) => hexToBytes(wallet))
      const key = hexToBytes(vector.device)
      if (vector.error) {
        expect(() => deviceRotationEnvelope(DEVICE_DOMAIN, oldWallet, newWallet, key, vector.rotations)).toThrow(
          expect.objectContaining({ name: 'ProtocolError', code: vector.error }),
        )
        return
      }
      expect(bytesToHex(deviceRotationBody(oldWallet, newWallet, key, vector.rotations))).toBe(vector.body)
      const message = deviceRotationEnvelope(DEVICE_DOMAIN, oldWallet, newWallet, key, vector.rotations)
      expect(bytesToHex(message)).toBe(vector.envelope)
      verifySignature(key, message, hexToBytes(vector.signature))
    })
  }

  it('is not a device binding, and rejects widths and counters it cannot encode', () => {
    const [vector] = vectors.device_rotations
    const [oldWallet, newWallet] = [vector.old_wallet, vector.new_wallet].map((wallet) => hexToBytes(wallet))
    const key = hexToBytes(vector.device)
    expect(deviceRotationBody(oldWallet, newWallet, key, 0)[1]).toBe(Kind.Rotation)
    expect(Kind.Rotation).not.toBe(Kind.DeviceBinding)
    const length = expect.objectContaining({ name: 'ProtocolError', code: 'Length' })
    expect(() => deviceRotationBody(oldWallet.subarray(1), newWallet, key, 0)).toThrow(length)
    expect(() => deviceRotationBody(oldWallet, newWallet, key, -1)).toThrow(length)
    expect(() => deviceRotationBody(oldWallet, newWallet, key, 2 ** 32)).toThrow(length)
  })
})

describe('record addresses and the step', () => {
  it('derives the record address of every vector output like Rust', () => {
    for (const { output, address } of vectors.record_addresses.outputs) {
      const derived = recordAddress(PROGRAM, hexToBytes(output))
      expect(derived ? bytesToHex(derived) : '').toBe(address)
    }
    expect(vectors.record_addresses.outputs.some(({ address }) => address === '')).toBe(true)
    expect(vectors.record_addresses.outputs.some(({ address }) => address !== '')).toBe(true)
    expect(RECORD_BUMP).toBe(vectors.record_addresses.bump)
  })

  it('derives the claim address of every vector output like Rust', () => {
    for (const { output, claim_address: address } of vectors.record_addresses.outputs) {
      const derived = claimAddress(PROGRAM, hexToBytes(output))
      expect(derived ? bytesToHex(derived) : '').toBe(address)
    }
    expect(vectors.record_addresses.outputs.some(({ claim_address: a }) => a === '')).toBe(true)
    expect(vectors.record_addresses.outputs.some(({ claim_address: a }) => a !== '')).toBe(true)
    expect(bytesToHex(CLAIM_SEED)).toBe(vectors.record_addresses.claim_seed)
  })

  it('accepts an output only if both of its addresses exist', () => {
    for (const { output, address, claim_address: claim } of vectors.record_addresses.outputs) {
      expect(isRecordable(PROGRAM, hexToBytes(output))).toBe(address !== '' && claim !== '')
    }
    expect(vectors.record_addresses.outputs.some((o) => o.address !== '' && o.claim_address === '')).toBe(true)
  })

  it('has a claim address exactly when the canonical bump is the fixed one', async () => {
    const { getProgramDerivedAddress, getAddressDecoder } = await import('@solana/kit')
    const program = getAddressDecoder().decode(PROGRAM)
    for (let n = 0; n < 64; n++) {
      const output = sha256(Uint8Array.of(n))
      const [address, bump] = await getProgramDerivedAddress({
        programAddress: program,
        seeds: [new TextEncoder().encode('claim'), output],
      })
      const derived = claimAddress(PROGRAM, output)
      expect(derived !== undefined, `output ${n}`).toBe(bump === RECORD_BUMP)
      if (derived) expect(getAddressDecoder().decode(derived)).toBe(address)
    }
  })

  it('has a record address exactly when the canonical bump is the fixed one', async () => {
    const { getProgramDerivedAddress, getAddressDecoder } = await import('@solana/kit')
    const program = getAddressDecoder().decode(PROGRAM)
    for (let n = 0; n < 64; n++) {
      const output = sha256(Uint8Array.of(n))
      const [address, bump] = await getProgramDerivedAddress({
        programAddress: program,
        seeds: [new TextEncoder().encode('spent'), output],
      })
      const derived = recordAddress(PROGRAM, output)
      expect(derived !== undefined, `output ${n}`).toBe(bump === RECORD_BUMP)
      if (derived) expect(getAddressDecoder().decode(derived)).toBe(address)
    }
  })

  it('takes the step from the vectors', () => {
    expect(EXPIRY_STEP).toBe(vectors.expiry_step)
    expect(vectors.profiles.production.windows.expiryStep).toBe(EXPIRY_STEP)
  })
})

describe('reclaims', () => {
  const RECLAIM_DOMAIN = hexToBytes(vectors.domain.reclaim)
  for (const vector of vectors.reclaims.cases) {
    it(`matches Rust for a deadline of ${vector.deadline}`, () => {
      expect(bytesToHex(reclaimBody(vector.deadline))).toBe(vector.body)
      expect(bytesToHex(reclaimEnvelope(RECLAIM_DOMAIN, hexToBytes(vector.output), vector.deadline))).toBe(
        vector.envelope,
      )
    })
  }

  it('leaves the same record whatever the deadline, and refuses a deadline that does not fit', () => {
    expect(bytesToHex(recordContent())).toBe(vectors.reclaims.record_content)
    expect(() => reclaimBody(-1)).toThrow(expect.objectContaining({ code: 'Length' }))
    expect(() => reclaimBody(2 ** 32)).toThrow(expect.objectContaining({ code: 'Length' }))
  })
})

describe('the precompile layout', () => {
  for (const vector of vectors.secp256r1_layouts) {
    it(`writes ${vector.keys.length} signatures like Rust`, () => {
      const entries = vector.keys.map((key, i) => ({ key: hexToBytes(key), message: hexToBytes(vector.messages[i]) }))
      const data = writeVerification(entries, vector.signatures.map(hexToBytes))
      expect(bytesToHex(data)).toBe(vector.data)
    })
  }

  it('refuses no signature, more than the precompile takes and a part of the wrong width', () => {
    const entry = { key: new Uint8Array(33), message: new Uint8Array(96) }
    const signature = new Uint8Array(64)
    const length = expect.objectContaining({ name: 'ProtocolError', code: 'Length' })
    expect(() => writeVerification([], [])).toThrow(length)
    expect(() => writeVerification(Array(9).fill(entry), Array(9).fill(signature))).toThrow(length)
    expect(() => writeVerification([entry], [])).toThrow(length)
    expect(() => writeVerification([{ ...entry, key: new Uint8Array(32) }], [signature])).toThrow(length)
    expect(() => writeVerification([entry], [new Uint8Array(63)])).toThrow(length)
  })
})

describe('spend steps', () => {
  const NOW = 1_800_000_000
  const EXPIRY = 1_900_000_000
  const [alice, bob] = [2, 3].map((secret) => ({
    type: 'device' as const,
    key: p256.getPublicKey(new Uint8Array(32).fill(secret)),
  }))
  const account = { type: 'account' as const, address: new Uint8Array(32).fill(0xb5) }
  const caveats = (hopsLeft: number, expiry = EXPIRY): Caveats => ({
    expiry,
    hopsLeft,
    flags: 0,
    scopeKind: ScopeKind.Any,
    scope: new Uint8Array(20),
  })
  const recordable = (id: Uint8Array) => isRecordable(PROGRAM, id)
  const idOf = (predicate: (id: Uint8Array) => boolean) => {
    for (let n = 0; ; n++) {
      const id = sha256(Uint8Array.of(n, 0xee))
      if (predicate(id)) return id
    }
  }
  const input: Output = { id: idOf(recordable), owner: alice, amount: 20_000n, caveats: caveats(4) }
  const fails = (code: string) => expect.objectContaining({ name: 'ProtocolError', code })
  /** The first salt for which the spend does not fail only for lack of a record address. */
  const spend = (lockSeq: number, outputs: Outputs, from = input): Spend => {
    for (let n = 0; ; n++) {
      const step = { input: from.id, lockSeq, salt: new Uint8Array(16).fill(n), outputs }
      try {
        checkSpendStep(NOTE_DOMAIN, PROGRAM, from, step, NOW)
        return step
      } catch (error) {
        if (!(error instanceof Error) || (error as { code?: string }).code !== 'Unrecordable') return step
      }
    }
  }
  const pay = (hopsLeft: number, expiry = EXPIRY - EXPIRY_STEP): Outputs => ({
    type: 'one',
    owner: bob,
    caveats: caveats(hopsLeft, expiry),
  })
  const split = (amount0: bigint, owner1: typeof alice): Outputs => ({
    type: 'two',
    owner0: bob,
    amount0,
    caveats0: caveats(3, EXPIRY - EXPIRY_STEP),
    owner1,
  })
  const settle = (expiry = EXPIRY) => spend(NO_LOCK, { type: 'one', owner: account, caveats: caveats(3, expiry) })
  const check = (step: Spend, now: number, from = input) => {
    return () => checkSpendStep(NOTE_DOMAIN, PROGRAM, from, step, now)
  }

  it('checks a spend against its input before it is signed, like Rust', () => {
    expect(check(spend(0, pay(3)), NOW)).not.toThrow()
    expect(check(spend(0, split(12_000n, alice)), NOW)).not.toThrow()
    expect(check(spend(0, split(20_000n, alice)), NOW)).toThrow(fails('Amount'))
    expect(check(spend(0, split(12_000n, bob)), NOW)).toThrow(fails('Change'))
    expect(check(spend(0, pay(4)), NOW)).toThrow(fails('Attenuation'))
    expect(check(spend(NO_LOCK, pay(3)), NOW)).toThrow(fails('Lock'))
    expect(check({ ...spend(0, pay(3)), input: new Uint8Array(32).fill(8) }, NOW)).toThrow(fails('Linkage'))
    expect(check(spend(0, pay(3)), EXPIRY)).not.toThrow()
    expect(check(spend(0, pay(3)), EXPIRY + 1)).toThrow(fails('Expired'))
    expect(check(settle(), EXPIRY + GRACE)).not.toThrow()
    expect(check(settle(), EXPIRY + GRACE + 1)).toThrow(fails('Expired'))
    expect(check(spend(0, split(12_000n, alice)), NOW, { ...input, caveats: caveats(1) })).toThrow(fails('Depth'))
    expect(check(settle(), NOW, { ...input, owner: account })).toThrow(fails('Owner'))
    expect(check(settle(), -1)).toThrow(fails('Length'))
  })

  it('gives a payment to a device the step and leaves a payment to an account free of it', () => {
    expect(check(spend(0, pay(3, EXPIRY - EXPIRY_STEP + 1)), NOW)).toThrow(fails('ExpiryStep'))
    expect(check(spend(0, pay(3, EXPIRY)), NOW)).toThrow(fails('ExpiryStep'))
    expect(check(spend(0, pay(3, EXPIRY + 1)), NOW)).toThrow(fails('Attenuation'))
    expect(check(settle(EXPIRY), NOW)).not.toThrow()
    expect(check(settle(EXPIRY - 1), NOW)).not.toThrow()
  })

  it('refuses a spend whose outputs have no record address, and an input that has none', () => {
    const outputsOf = (step: Spend) => messageId(envelope(NOTE_DOMAIN, input.id, content(encodeSpendBody(step))))
    let unrecordable: Spend | undefined
    for (let n = 0; !unrecordable; n++) {
      const step = { input: input.id, lockSeq: 0, salt: new Uint8Array(16).fill(n), outputs: pay(3) }
      if (!recordable(outputId(outputsOf(step), 0))) unrecordable = step
    }
    expect(check(unrecordable, NOW)).toThrow(fails('Unrecordable'))
    const withoutAddress: Output = { ...input, id: idOf((id) => !recordable(id)) }
    expect(check({ ...spend(0, pay(3)), input: withoutAddress.id }, NOW, withoutAddress)).toThrow(fails('Unrecordable'))
  })

  it('refuses an issue whose output has no record address', () => {
    const [vector] = vectors.messages
    const issue = decodeIssue(hexToBytes(vector.wire)).message
    const accepted: number[] = []
    const refused: number[] = []
    for (let n = 0; accepted.length < 1 || refused.length < 1; n++) {
      const candidate = { ...issue, salt: new Uint8Array(16).fill(n) }
      try {
        checkIssueStep(NOTE_DOMAIN, PROGRAM, candidate)
        accepted.push(n)
      } catch (error) {
        expect(error).toEqual(fails('Unrecordable'))
        refused.push(n)
      }
    }
  })
})

describe('ticket freshness and the lock window', () => {
  const [vector] = vectors.payments
  const base = receiver(vector)
  const issue = decodeIssue(hexToBytes(vector.issue))
  const spends = decodeSpends(vector.spends)
  const issuer = issue.message.issuer
  const resign = (ticket: BondTicket, changes: Partial<BondTicket>): BondTicket => {
    const changed = { ...ticket, ...changes }
    const secret = vectors.attesters.find(({ id }) => id === ticket.attester)!.secret
    const signature = ed25519.sign(ticketMessage(hexToBytes(vectors.domain.ticket), changed), hexToBytes(secret))
    return { ...changed, signature }
  }
  const pay = (changes: (ticket: BondTicket) => Partial<BondTicket>, only?: Uint8Array) => () =>
    verifyPayment(
      base,
      issue,
      spends,
      decodeTickets(vector.tickets).map((t) =>
        only && !bytesToHex(t.device).includes(bytesToHex(only)) ? t : resign(t, changes(t)),
      ),
    )
  const refused = expect.objectContaining({ name: 'ProtocolError', code: 'Ticket' })

  it('accepts a ticket until validUntil and never for longer than three days from now', () => {
    const at = (validUntil: number) => pay(() => ({ validUntil }))
    expect(at(vector.now - 1)).toThrow(refused)
    expect(at(vector.now)).not.toThrow()
    expect(at(vector.now + TICKET_TTL_MAX)).not.toThrow()
    expect(at(vector.now + TICKET_TTL_MAX + 1)).toThrow(refused)
    expect(at(2 ** 32 - 1)).toThrow(refused)
    expect(TICKET_TTL_MAX).toBe(3 * 24 * 60 * 60)
  })

  it('needs the lock to outlast the conflict window by a second', () => {
    const settledBy = issue.message.caveats.expiry + GRACE + CHALLENGE
    const at = (lockUntil: number) => pay(() => ({ lockUntil }), issuer)
    expect(at(settledBy)).toThrow(refused)
    expect(at(settledBy + 1)).not.toThrow()
  })

  it('needs the bond to cover the amount at the payment limit, not at the amount', () => {
    const amount = issue.message.amount
    expect(pay(() => ({ bond: 4n * amount - 1n }), issuer)).toThrow(refused)
    expect(pay(() => ({ bond: 4n * amount }), issuer)).not.toThrow()
  })
})
