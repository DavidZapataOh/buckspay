import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex as hex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { address, getAddressEncoder } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import vectors from '../../anchor/crates/protocol/tests/vectors/v1.json'
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH } from './cluster'
import { ProtocolError } from './codec'
import { domain, Purpose } from './hash'
import {
  decodeStatement,
  encodeStatement,
  MAX_PARTICIPANTS,
  nettingAddress,
  type NettingStatement,
  publicInputs,
  sessionField,
  statementContent,
  statementEnvelope,
} from './netting'
import { verifyEd25519 } from './ticket'

const PROGRAM = new Uint8Array(32).fill(0xb0)
const nettingDomain = domain(Purpose.Netting, DEVNET_GENESIS_HASH, PROGRAM)
const v = vectors.netting
const R = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n
const be = (value: bigint) => hexToBytes(value.toString(16).padStart(64, '0'))
const programBytes = (base58: string) => Uint8Array.from(getAddressEncoder().encode(address(base58)))
const seed = (i: number) => new Uint8Array(32).fill(0x51 + i)

const codeOf = (run: () => unknown) => {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof ProtocolError ? error.code : String(error)
  }
}

const statement = (n: number, expires = 1_900_000_000): NettingStatement => ({
  session: new Uint8Array(32).fill(0x50 + n),
  mint: new Uint8Array(32).fill(3),
  participants: n,
  total: 1_000_000n * BigInt(n),
  expires,
  root: be(5n),
  ephemeral: Array.from({ length: n }, (_, i) => ed25519.getPublicKey(seed(i))),
})

describe('netting statement', () => {
  it('matches the Rust statements for n = 2, 5 and 8', () => {
    expect(hex(nettingDomain)).toBe(v.domain.devnet)
    const mainnet = domain(Purpose.Netting, MAINNET_GENESIS_HASH, PROGRAM)
    expect(hex(mainnet)).toBe(v.domain.mainnet)
    const programs = {
      production: programBytes(vectors.profiles.production.programIds.devnet),
      short: programBytes(vectors.profiles.short.programId),
    }
    expect(v.statements.map((s) => s.n)).toEqual([2, 5, 8])
    for (const s of v.statements) {
      const body = hexToBytes(s.body)
      expect(body.length).toBe(111 + 32 * s.n)
      const decoded = decodeStatement(body)
      expect(hex(encodeStatement(decoded))).toBe(s.body)
      expect(hex(statementContent(decoded))).toBe(s.content)
      expect(hex(statementEnvelope(decoded, nettingDomain))).toBe(s.envelope.devnet)
      expect(hex(statementEnvelope(decoded, mainnet))).toBe(s.envelope.mainnet)
      expect(hex(sessionField(decoded))).toBe(s.session_field)
      expect(publicInputs(decoded).map(hex)).toEqual(s.public_inputs)
      for (const key of ['production', 'short'] as const) {
        const found = nettingAddress(programs[key], statementContent(decoded))
        expect(found === null ? null : hex(found), `${s.n} ${key}`).toBe(s.netting_address[key])
      }
      const message = statementEnvelope(decoded, nettingDomain)
      expect(s.signatures.length).toBe(s.n)
      s.signatures.forEach((signature, i) => {
        expect(hex(ed25519.sign(message, seed(i))), `n ${s.n} signer ${i}`).toBe(signature)
        expect(verifyEd25519(decoded.ephemeral[i], message, hexToBytes(signature))).toBe(true)
      })
    }
  })

  it('carries expires in the content and not in the public inputs', () => {
    const a = statement(5)
    const b = { ...a, expires: a.expires + 1 }
    expect(hex(statementContent(a))).not.toBe(hex(statementContent(b)))
    // expires is no public input of its own: it reaches the proof only through the session field
    expect(hex(publicInputs(a)[0])).not.toBe(hex(publicInputs(b)[0]))
    expect(publicInputs(a).slice(1).map(hex)).toEqual(publicInputs(b).slice(1).map(hex))
    expect(publicInputs(a).map(hex)).toEqual([hex(sessionField(a)), hex(be(5n)), hex(be(5_000_000n)), hex(a.root)])
    const env = statementEnvelope(a, nettingDomain)
    expect(hex(env)).toBe(hex(concatBytes(nettingDomain, a.session, statementContent(a))))
  })

  it('clears the top three bits of the session field and stays below r', () => {
    for (let i = 0; i < 256; i++) {
      const n = 2 + (i % 7)
      const s = { ...statement(n, i * 1_000), session: new Uint8Array(32).fill(i) }
      const expires = new Uint8Array(4)
      new DataView(expires.buffer).setUint32(0, s.expires, true)
      const expected = sha256(
        concatBytes(
          utf8ToBytes('BUCKSPAY:v1:netting-session'),
          s.session,
          s.mint,
          expires,
          Uint8Array.of(n),
          ...s.ephemeral,
        ),
      )
      expected[0] &= 0x1f
      const field = sessionField(s)
      expect(hex(field)).toBe(hex(expected))
      expect(BigInt(`0x${hex(field)}`) < R).toBe(true)
      expect(hex(publicInputs(s)[0])).toBe(hex(field))
    }
  })

  it('session_field_binds_mint_expires_keys', () => {
    const base = statement(5)
    const variants: [string, NettingStatement][] = [
      [
        'other key',
        { ...base, ephemeral: [...base.ephemeral.slice(0, 4), ed25519.getPublicKey(new Uint8Array(32).fill(0x60))] },
      ],
      ['other expires', { ...base, expires: base.expires + 1 }],
      ['other mint', { ...base, mint: new Uint8Array(32).fill(4) }],
    ]
    for (const [name, changed] of variants) {
      expect(hex(sessionField(changed)), name).not.toBe(hex(sessionField(base)))
      expect(publicInputs(changed).slice(1).map(hex), name).toEqual(publicInputs(base).slice(1).map(hex))
    }
    const v = vectors.nettingBinding
    const fields = new Set([v.base.session_field])
    expect(hex(sessionField(decodeStatement(hexToBytes(v.base.body))))).toBe(v.base.session_field)
    expect(v.cases.map((c) => c.name)).toEqual(['other_key', 'other_expires', 'other_mint'])
    for (const c of v.cases) {
      expect(hex(sessionField(decodeStatement(hexToBytes(c.body)))), c.name).toBe(c.session_field)
      fields.add(c.session_field)
    }
    expect(fields.size).toBe(4)
  })

  it('refuses invalid statements on encode with the Rust codes', () => {
    expect(MAX_PARTICIPANTS).toBe(8)
    const ok = statement(3)
    expect(codeOf(() => encodeStatement(ok))).toBeUndefined()
    const cases: [string, NettingStatement, string][] = [
      ['n = 1', { ...statement(2), participants: 1, ephemeral: statement(2).ephemeral.slice(0, 1) }, 'Length'],
      [
        'n = 9',
        { ...statement(8), participants: 9, ephemeral: [...statement(8).ephemeral, new Uint8Array(32).fill(1)] },
        'Length',
      ],
      ['keys do not match n', { ...ok, participants: 4 }, 'Length'],
      ['duplicate key', { ...ok, ephemeral: [ok.ephemeral[0], ok.ephemeral[1], ok.ephemeral[0]] }, 'Signer'],
      ['root = r', { ...ok, root: be(R) }, 'Amount'],
      ['total above u64', { ...ok, total: 2n ** 64n }, 'Length'],
      ['expires above u32', { ...ok, expires: 2 ** 32 }, 'Length'],
    ]
    for (const [name, s, code] of cases)
      expect(
        codeOf(() => encodeStatement(s)),
        name,
      ).toBe(code)
    expect(codeOf(() => encodeStatement({ ...ok, root: be(R - 1n) }))).toBeUndefined()
  })

  it('returns null for an address on the curve, like Rust', () => {
    const program = new Uint8Array(32).fill(7)
    let found = 0
    let none = 0
    for (let n = 0; n < 256; n++) {
      const c = new Uint8Array(32)
      new DataView(c.buffer).setUint32(0, n, true)
      if (nettingAddress(program, c) === null) none++
      else found++
    }
    expect(none).toBeGreaterThan(0)
    expect(found).toBeGreaterThanOrEqual(100)
  })
})
