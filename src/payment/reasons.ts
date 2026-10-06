import { type ErrorCode, ProtocolError, TicketRefusal } from '../protocol'

/** Why a receiver did not accept a payment; the number travels in the receipt. */
export const Reason = {
  Accepted: 0,
  Unreadable: 1,
  Invalid: 2,
  Signature: 3,
  Ticket: 4,
  Expired: 5,
  Window: 6,
  NotForYou: 7,
  Scope: 8,
  DoubleSpend: 9,
  OverLimit: 10,
  AboveMax: 11,
  NotSaved: 12,
} as const
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type Reason = (typeof Reason)[keyof typeof Reason]

export const REASONS = new Set<number>(Object.values(Reason))

const PROTOCOL_REASON = {
  Length: Reason.Unreadable,
  Version: Reason.Unreadable,
  Kind: Reason.Unreadable,
  Owner: Reason.Invalid,
  Flags: Reason.Invalid,
  ScopeKind: Reason.Invalid,
  Scope: Reason.Scope,
  Amount: Reason.Invalid,
  Depth: Reason.Invalid,
  Attenuation: Reason.Invalid,
  Linkage: Reason.Invalid,
  Signer: Reason.Signature,
  Signature: Reason.Signature,
  Expired: Reason.Expired,
  Change: Reason.Invalid,
  Lock: Reason.Invalid,
  Ticket: Reason.Ticket,
  Window: Reason.Window,
  Payee: Reason.NotForYou,
  ExpiryStep: Reason.Invalid,
  Unrecordable: Reason.Invalid,
} as const satisfies Record<ErrorCode, Reason>

/** The reason a protocol failure maps to; anything that is not a protocol failure is not the payment's fault. */
export function reasonOf(error: unknown): Reason {
  if (error instanceof TicketRefusal && error.reason === 'AttesterCap') return Reason.OverLimit
  return error instanceof ProtocolError ? PROTOCOL_REASON[error.code] : Reason.Unreadable
}
