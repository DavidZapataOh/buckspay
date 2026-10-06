import { bytesToHex } from '@noble/hashes/utils.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeBondTicket } from '../../protocol'
import { makeTicket, MINT, party } from '../../payment/testing/world'
import AsyncStorage, { resetAsyncStorage } from '../../test-support/async-storage'
import { loadTickets, requestTickets, saveTickets, TicketServiceError } from './tickets'

vi.mock('@react-native-async-storage/async-storage', () => import('../../test-support/async-storage'))

const device = party(1).key
const ticket = (lockSeq: number) =>
  makeTicket({ device, mint: MINT, lockSeq, bond: 100n, backing: 50n, lockUntil: 2_000_000_000 })
const answer = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

beforeEach(() => resetAsyncStorage())

describe('requesting tickets', () => {
  it('asks for every lock in one batch and reads each answer', async () => {
    const [a, b] = [ticket(3), ticket(4)]
    const fetcher = answer({
      attester: 7,
      now: 1,
      results: [
        { key: bytesToHex(device), lockSeq: 3, status: 'ok', ticket: bytesToHex(encodeBondTicket(a)), validUntil: 9 },
        { key: bytesToHex(device), lockSeq: 4, status: 'refused', reason: 'lock_absent' },
      ],
    })
    const result = await requestTickets('https://gw.example', device, [3, 4], 86_400, fetcher)
    expect(result.tickets).toEqual([a])
    expect(result.refused).toEqual([{ lockSeq: 4, reason: 'lock_absent' }])
    expect(b.lockSeq).toBe(4)
    const [url, init] = vi.mocked(fetcher).mock.calls[0]
    expect(url).toBe('https://gw.example/v1/tickets')
    expect(JSON.parse(String(init?.body))).toEqual({
      locks: [
        { key: bytesToHex(device), lockSeq: 3 },
        { key: bytesToHex(device), lockSeq: 4 },
      ],
      lifetime: 86_400,
    })
  })

  it('refuses a ticket for another device or lock than the one asked about', async () => {
    const other = makeTicket({ device: party(2).key, mint: MINT, lockSeq: 3, bond: 1n, backing: 1n, lockUntil: 2e9 })
    const wrongLock = ticket(9)
    for (const sent of [other, wrongLock]) {
      const fetcher = answer({
        attester: 7,
        now: 1,
        results: [{ key: bytesToHex(device), lockSeq: 3, status: 'ok', ticket: bytesToHex(encodeBondTicket(sent)) }],
      })
      await expect(requestTickets('https://gw.example', device, [3], 86_400, fetcher)).rejects.toThrow(
        TicketServiceError,
      )
    }
  })

  it('says when the service did not answer, with what it said', async () => {
    const failure = requestTickets('https://gw.example', device, [3], 86_400, answer({ retryAfter: 30 }, 503))
    await expect(failure).rejects.toMatchObject({ status: 503, retryAfter: 30 })
    const offline = vi.fn(async () =>
      Promise.reject(new TypeError('Network request failed')),
    ) as unknown as typeof fetch
    await expect(requestTickets('https://gw.example', device, [3], 86_400, offline)).rejects.toMatchObject({
      status: 0,
    })
  })

  it('asks for at most eight locks at once', async () => {
    await expect(
      requestTickets('https://gw.example', device, [0, 1, 2, 3, 4, 5, 6, 7, 8], 86_400, answer({})),
    ).rejects.toThrow(RangeError)
  })
})

describe('stored tickets', () => {
  it('are kept per device key and lock, and read back as they were signed', async () => {
    await saveTickets(device, [ticket(3), ticket(4)])
    expect(await loadTickets(device)).toEqual(
      new Map([
        [3, ticket(3)],
        [4, ticket(4)],
      ]),
    )
    expect(await loadTickets(party(2).key)).toEqual(new Map())
  })

  it('replace the ticket of a lock with its newer one and drop what is unreadable', async () => {
    await saveTickets(device, [ticket(3)])
    const newer = { ...ticket(3), validUntil: ticket(3).validUntil + 3_600 }
    await saveTickets(device, [newer])
    expect((await loadTickets(device)).get(3)?.validUntil).toBe(newer.validUntil)
    await AsyncStorage.setItem('tickets:v1', 'not json')
    expect(await loadTickets(device)).toEqual(new Map())
  })
})
