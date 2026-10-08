import { readFileSync } from 'node:fs'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it, vi } from 'vitest'
import {
  type ChainReads,
  NETTING_DISCRIMINATOR,
  NettingRefused,
  nettingInstructions,
  nettingOutcome,
  nettingReading,
  payNettingRecord,
  quoteNettingRecord,
  recordNettingPaying,
  submitNetting,
  WalletRefusedV1,
} from './record'
import { decodeStatement } from '../../protocol/netting'
import { address, compileTransactionMessage, getCompiledTransactionMessageEncoder } from '@solana/kit'

const vector = JSON.parse(readFileSync('gateway/tests/vectors/netting_record.json', 'utf8'))
const statement = hexToBytes(vector.statement)
const signatures: Uint8Array[] = vector.signatures.map(hexToBytes)
const proof = hexToBytes(vector.proof)
const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }))

describe('netting records', () => {
  it('submitNetting_maps_409_to_recorded_and_429_to_capped', async () => {
    const url = 'https://gateway.test'
    expect(
      await submitNetting(statement, signatures, proof, undefined, { url, fetch: answer(200, { signature: 'S' }) }),
    ).toEqual({ signature: 'S', pending: false })
    expect(
      await submitNetting(statement, signatures, proof, undefined, { url, fetch: answer(202, { signature: 'U' }) }),
    ).toEqual({ signature: 'U', pending: true })
    expect(
      await submitNetting(statement, signatures, proof, undefined, { url, fetch: answer(409, { reason: 'recorded' }) }),
    ).toEqual({ recorded: true })
    expect(
      await submitNetting(statement, signatures, proof, undefined, { url, fetch: answer(429, { reason: 'cap' }) }),
    ).toEqual({ capped: true })
    await expect(
      submitNetting(statement, signatures, proof, undefined, { url, fetch: answer(400, { reason: 'expired' }) }),
    ).rejects.toEqual(new NettingRefused('expired'))
  })

  it('posts the statement, the signatures in order and the proof as hex', async () => {
    const fetch = answer(200, { signature: 'S' })
    await submitNetting(statement, signatures, proof, undefined, { url: 'https://gateway.test', fetch })
    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('https://gateway.test/v1/nettings')
    expect(JSON.parse(init.body as string)).toEqual({
      statement: vector.statement,
      signatures: vector.signatures,
      proof: vector.proof,
    })
  })

  it('member_paid_record_builds_the_same_instructions', () => {
    const built = nettingInstructions(address(vector.programId), address(vector.payer), statement, signatures, proof)
    expect(built).toHaveLength(2)
    built.forEach((ix, k) => {
      const want = vector.instructions[k]
      expect(ix.programAddress).toBe(want.programId)
      expect(bytesToHex(ix.data as Uint8Array)).toBe(want.data)
      expect((ix.accounts ?? []).map((a) => [a.address, a.role])).toEqual(
        want.accounts.map((a: { pubkey: string; isSigner: boolean; isWritable: boolean }) => [
          a.pubkey,
          (a.isSigner ? 2 : 0) + (a.isWritable ? 1 : 0),
        ]),
      )
    })
  })

  it('sends the paid lane payment with the body', async () => {
    const fetch = answer(200, { signature: 'S' })
    await submitNetting(statement, signatures, proof, 'PAYSIG', { url: 'https://gateway.test', fetch })
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).payment).toBe('PAYSIG')
  })

  it('quotes and pays the record fee with a small v0 transfer and the content as memo', async () => {
    const fetch = answer(200, { quoteId: 'q7', lamports: 1038488, sponsor: vector.payer, expiresAt: 4_000_000_000 })
    const quote = await quoteNettingRecord({ url: 'https://gateway.test', fetch })
    expect(quote.lamports).toBe(1038488n)
    const content = new Uint8Array(32).fill(5)
    let sent: { version: number | 'legacy'; instructions: { programAddress: string; data?: Uint8Array }[] } | undefined
    const send = vi.fn(async (message: never) => {
      sent = message
      return 'PAY'
    })
    expect(
      await payNettingRecord({ address: address(vector.payer) } as never, content, quote, {
        send,
        confirm: vi.fn(async () => null),
      } as never),
    ).toBe('PAY')
    expect(sent!.version).toBe(0)
    expect(sent!.instructions.map((i) => i.programAddress)).toEqual([
      '11111111111111111111111111111111',
      'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    ])
    expect(new TextDecoder().decode(sent!.instructions[1].data)).toBe(`${bytesToHex(content)}:q7`)
    const size = getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(sent as never)).length + 1 + 64
    expect(size).toBeLessThanOrEqual(1232)
  })

  describe('nettingOutcome decides from finalized chain reads only', () => {
    const st = decodeStatement(statement)
    const keep = 30 * 86_400
    const program = hexToBytes(vector.programIdHex)
    const record = (closable = st.expires + keep, disc = NETTING_DISCRIMINATOR, size = 48) => {
      const data = new Uint8Array(size)
      data.set(disc.slice(0, Math.min(8, size)))
      if (size >= 48) new DataView(data.buffer).setUint32(44, closable, true)
      return data
    }
    type Page = { ok: boolean; recordsNetting: boolean; blockTime: number }[]
    const reads = (o: {
      account?: { owner: Uint8Array; data: Uint8Array }
      time: number
      slot?: bigint
      pages?: Page[]
    }): ChainReads => {
      const pages = o.pages ?? []
      return {
        account: vi.fn(async () => (o.account ? { slot: o.slot ?? 9n, ...o.account } : { slot: o.slot ?? 9n })),
        blockTime: vi.fn(async () => o.time),
        history: vi.fn(async (_address: unknown, before?: string) => {
          const k = before === undefined ? 0 : Number(before.split(':')[0]) + 1
          return (pages[k] ?? []).map((h, i) => ({ signature: `${k}:${i}`, ...h }))
        }),
      }
    }
    const system = new Uint8Array(32)
    const real = { owner: program, data: record() }
    const cases: [string, Parameters<typeof reads>[0], string][] = [
      ['a record is recorded', { account: real, time: st.expires + 5 }, 'recorded'],
      ['no account before expires is pending', { time: st.expires - 1 }, 'pending'],
      [
        'a_system_account_at_the_record_address_is_not_a_record (before expires)',
        { account: { owner: system, data: new Uint8Array(0) }, time: st.expires - 1 },
        'pending',
      ],
      [
        'an_account_with_another_owner_or_size_is_not_a_record (owner)',
        { account: { owner: system, data: record() }, time: st.expires - 1 },
        'pending',
      ],
      [
        'an_account_with_another_owner_or_size_is_not_a_record (size)',
        { account: { owner: program, data: record(undefined, undefined, 49) }, time: st.expires - 1 },
        'pending',
      ],
      [
        'an account with another discriminator is not a record',
        { account: { owner: program, data: record(undefined, new Uint8Array(8).fill(1)) }, time: st.expires - 1 },
        'pending',
      ],
      [
        'an account with another closable_at is not a record',
        { account: { owner: program, data: record(st.expires + keep - 1) }, time: st.expires - 1 },
        'pending',
      ],
      [
        'after the window, a record_netting in history is recorded',
        { time: st.expires + keep, pages: [[{ ok: true, recordsNetting: true, blockTime: st.expires - 10 }]] },
        'recorded',
      ],
      [
        'after the window, a bare transfer to the address is not a record',
        { time: st.expires + keep, pages: [[{ ok: true, recordsNetting: false, blockTime: st.expires - 10 }]] },
        'void',
      ],
      ['after the window, no history is undecided', { time: st.expires + keep }, 'undecided'],
    ]
    for (const [name, o, want] of cases) {
      it(name, async () => {
        expect(await nettingOutcome(st, { reads: reads(o), programId: program, voidSeenAt: 1n })).toBe(want)
      })
    }

    it('a_system_account_at_the_record_address_is_not_a_record (after expires: void)', async () => {
      const o = { account: { owner: system, data: new Uint8Array(0) }, time: st.expires, slot: 12n }
      expect(await nettingOutcome(st, { reads: reads(o), programId: program, voidSeenAt: 9n })).toBe('void')
    })

    it('netting_void_needs_two_finalized_reads', async () => {
      const r = reads({ time: st.expires, slot: 12n })
      expect(await nettingReading(st, { reads: r, programId: program })).toEqual({ outcome: 'void', slot: 12n })
      expect(await nettingOutcome(st, { reads: r, programId: program })).toBe('pending')
      expect(await nettingOutcome(st, { reads: r, programId: program, voidSeenAt: 12n })).toBe('pending')
      expect(await nettingOutcome(st, { reads: r, programId: program, voidSeenAt: 11n })).toBe('void')
      expect(r.account).toHaveBeenCalledWith(expect.anything(), 'finalized')
    })

    it('history_paged_until_before_expires', async () => {
      const dust: Page = Array.from({ length: 1_000 }, () => ({
        ok: true,
        recordsNetting: false,
        blockTime: st.expires + 100,
      }))
      const r = reads({
        time: st.expires + keep,
        pages: [dust, dust, [{ ok: true, recordsNetting: true, blockTime: st.expires - 3 }]],
      })
      expect(await nettingOutcome(st, { reads: r, programId: program })).toBe('recorded')
      expect(r.history).toHaveBeenCalledTimes(3)
      const none = reads({
        time: st.expires + keep,
        slot: 20n,
        pages: [dust, [{ ok: true, recordsNetting: false, blockTime: st.expires - 1 }]],
      })
      expect(await nettingOutcome(st, { reads: none, programId: program, voidSeenAt: 3n })).toBe('void')
    })

    it('ignores a phone clock an hour fast or slow', async () => {
      for (const skew of [-3_600_000, 3_600_000]) {
        vi.useFakeTimers()
        vi.setSystemTime((st.expires - 1) * 1000 + skew)
        expect(await nettingOutcome(st, { reads: reads({ time: st.expires - 1 }), programId: program })).toBe('pending')
        expect(
          await nettingOutcome(st, {
            reads: reads({ time: st.expires, slot: 30n }),
            programId: program,
            voidSeenAt: 29n,
          }),
        ).toBe('void')
        vi.useRealTimers()
      }
    })
  })

  it('falls back to v0 for two participants when the wallet refuses V1, and only then', async () => {
    const sent: string[] = []
    const send = vi.fn(async (message: { version: number | 'legacy' }) => {
      sent.push(String(message.version))
      if (message.version === 1) throw new Error('unsupported transaction version')
      return 'SIG'
    })
    const two = {
      statement: hexToBytes(vector.two.statement),
      signatures: vector.two.signatures.map(hexToBytes),
      proof: hexToBytes(vector.two.proof),
    }
    const deps = {
      send,
      programId: address(vector.programId),
      payer: address(vector.payer),
      confirm: vi.fn(async () => null),
    }
    expect(await recordNettingPaying({} as never, two.statement, two.signatures, two.proof, deps as never)).toEqual({
      signature: 'SIG',
    })
    expect(sent).toEqual(['1', '0'])
    await expect(recordNettingPaying({} as never, statement, signatures, proof, deps as never)).rejects.toBeInstanceOf(
      WalletRefusedV1,
    )
  })
})
