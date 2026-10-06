import AsyncStorage from '@react-native-async-storage/async-storage'
import { equalBytes } from '@noble/curves/utils.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { type BondTicket, decodeBondTicket, encodeBondTicket } from '../../protocol'

/** The two lifetimes the service grants: a day, and the longest a receiver accepts (71 hours). */
export type TicketLifetime = 86_400 | 255_600

export const MAX_TICKET_BATCH = 8

/** The attester's service did not give tickets: what it said, or `status` 0 when nothing answered. */
export class TicketServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'TicketServiceError'
  }
}

export type Tickets = {
  tickets: BondTicket[]
  /** Locks the service would not vouch for, with its reason (`lock_absent`, `impaired`, ...). */
  refused: { lockSeq: number; reason: string }[]
}

type Answer = { results?: { lockSeq: number; status: string; ticket?: string; reason?: string }[]; retryAfter?: number }

/** Asks the attester at `url` for a ticket of each of the device key's locks, in one request. */
export async function requestTickets(
  url: string,
  key: Uint8Array,
  lockSeqs: readonly number[],
  lifetime: TicketLifetime,
  fetcher: typeof fetch = fetch,
): Promise<Tickets> {
  if (lockSeqs.length === 0 || lockSeqs.length > MAX_TICKET_BATCH) throw new RangeError('A batch has 1 to 8 locks')
  const hex = bytesToHex(key)
  let response: Response
  try {
    response = await fetcher(`${url}/v1/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locks: lockSeqs.map((lockSeq) => ({ key: hex, lockSeq })), lifetime }),
    })
  } catch (error) {
    throw new TicketServiceError(0, error instanceof Error ? error.message : 'No answer')
  }
  const body: Answer = await response.json().catch(() => ({}))
  if (!response.ok) {
    const header = Number(response.headers.get('Retry-After'))
    throw new TicketServiceError(
      response.status,
      'The attester did not give tickets',
      body.retryAfter ?? (header > 0 ? header : undefined),
    )
  }
  const result: Tickets = { tickets: [], refused: [] }
  for (const entry of body.results ?? []) {
    if (!lockSeqs.includes(entry.lockSeq)) throw new TicketServiceError(200, 'An answer for a lock that was not asked')
    if (entry.status === 'ok' && entry.ticket) {
      const ticket = decodeBondTicket(hexToBytes(entry.ticket))
      if (!equalBytes(ticket.device, key) || ticket.lockSeq !== entry.lockSeq) {
        throw new TicketServiceError(200, 'A ticket for another lock than the one asked about')
      }
      result.tickets.push(ticket)
    } else {
      result.refused.push({ lockSeq: entry.lockSeq, reason: entry.reason ?? 'refused' })
    }
  }
  return result
}

const STORE = 'tickets:v1'

type Stored = Record<string, Record<string, string>>

async function read(): Promise<Stored> {
  try {
    const stored: unknown = JSON.parse((await AsyncStorage.getItem(STORE)) ?? '{}')
    return stored && typeof stored === 'object' ? (stored as Stored) : {}
  } catch {
    return {}
  }
}

/** Keeps the tickets of a device key's locks, replacing each lock's earlier one. */
export async function saveTickets(key: Uint8Array, tickets: readonly BondTicket[]): Promise<void> {
  const stored = await read()
  const own = { ...stored[bytesToHex(key)] }
  for (const ticket of tickets) own[String(ticket.lockSeq)] = bytesToHex(encodeBondTicket(ticket))
  await AsyncStorage.setItem(STORE, JSON.stringify({ ...stored, [bytesToHex(key)]: own }))
}

/** The stored ticket of each lock of the device key; one that does not decode is left out. */
export async function loadTickets(key: Uint8Array): Promise<Map<number, BondTicket>> {
  const tickets = new Map<number, BondTicket>()
  for (const [lockSeq, wire] of Object.entries((await read())[bytesToHex(key)] ?? {})) {
    try {
      tickets.set(Number(lockSeq), decodeBondTicket(hexToBytes(wire)))
    } catch {
      // Dropped: the next refresh asks again.
    }
  }
  return tickets
}
