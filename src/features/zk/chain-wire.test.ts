import { readFileSync } from 'node:fs'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { content, decodeIssue, decodeSpend, encodeIssueBody, outputId, type Signed, type Spend } from '../../protocol'
import { NOTE_DOMAIN } from '../../payment/testing/world'
import type { NoteChain } from '../settlement/chain'
import { encodeProverChain, zkChain } from './chain-wire'
import { settledChainFixture } from './testing/chain'

type Vectors = {
  domain: string
  valid: {
    name: string
    messages: { kind: number; body: string; sig_r: string; sig_s: string; key: string }[]
    openings: { owner: string; amount: number; caveats: string; salt: string; index: number }[]
    message_ids: string[]
  }[]
}

const vectors = JSON.parse(
  readFileSync(new URL('../../../prover/testdata/vectors.json', import.meta.url), 'utf8'),
) as Vectors

const u16 = (n: number) => Uint8Array.of(n >> 8, n & 0xff)
const u64 = (n: number) => {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n))
  return out
}

/** The prover's chain form, written straight from the generator's JSON. */
function expected(domain: string, c: Vectors['valid'][number]) {
  const parts = [hexToBytes(domain), Uint8Array.of(c.messages.length)]
  for (const m of c.messages) {
    const body = hexToBytes(m.body)
    parts.push(
      Uint8Array.of(m.kind),
      u16(body.length),
      body,
      hexToBytes(m.sig_r),
      hexToBytes(m.sig_s),
      hexToBytes(m.key),
    )
  }
  for (const o of c.openings) {
    parts.push(hexToBytes(o.owner), u64(o.amount), hexToBytes(o.caveats), hexToBytes(o.salt), Uint8Array.of(o.index))
  }
  return concatBytes(...parts)
}

function noteChain(c: Vectors['valid'][number]): NoteChain {
  const first = hexToBytes(c.messages[0].body + c.messages[0].sig_r + c.messages[0].sig_s)
  const issue = decodeIssue(first)
  const spends: Signed<Spend>[] = c.messages.slice(1).map((m, i) => {
    const input = outputId(hexToBytes(c.message_ids[i]), c.openings[i + 1].index)
    return decodeSpend(concatBytes(input, hexToBytes(m.body), hexToBytes(m.sig_r), hexToBytes(m.sig_s)))
  })
  return { issue, spends }
}

describe('encodeProverChain', () => {
  const chains = vectors.valid.filter((c) => c.messages.length > 1)

  it('has chains to check', () => {
    expect(chains.length).toBeGreaterThan(3)
  })

  it.each(chains.map((c) => [c.name, c] as const))(
    'writes %s the way the generator of the circuit vectors does',
    (_, c) => {
      const bytes = encodeProverChain(hexToBytes(vectors.domain), noteChain(c))
      expect(bytesToHex(bytes)).toBe(bytesToHex(expected(vectors.domain, c)))
    },
  )
})

describe('zkChain', () => {
  it('carries what the program needs and none of the holders', () => {
    const chain = settledChainFixture(3)
    const shape = zkChain(NOTE_DOMAIN, chain)
    expect(shape.messages).toHaveLength(chain.spends.length + 1)
    expect(shape.lockSeq).toBe(chain.issue.message.lockSeq)
    expect(shape.amount).toBe(chain.issue.message.amount)
    expect(shape.payee).toEqual(new Uint8Array(32).fill(9))
    expect(shape.payAmount).toBe(chain.issue.message.amount)
    expect(shape.messages[0].content).toEqual(content(encodeProverBodyOfIssue(chain)))
    expect(shape.messages.at(-1)?.nextBit).toBe(0)
  })

  it('refuses a chain that does not end in an account or has no spend', () => {
    const chain = settledChainFixture(2)
    expect(() => zkChain(NOTE_DOMAIN, { ...chain, spends: chain.spends.slice(0, -1) })).toThrow()
    expect(() => zkChain(NOTE_DOMAIN, { ...chain, spends: [] })).toThrow()
  })

  it('refuses a chain longer than the circuit proves', () => {
    const chain = settledChainFixture(2)
    const spends = Array.from({ length: 17 }, () => chain.spends[0])
    expect(() => encodeProverChain(NOTE_DOMAIN, { ...chain, spends })).toThrow()
  })
})

const encodeProverBodyOfIssue = (chain: NoteChain) => encodeIssueBody(chain.issue.message)
