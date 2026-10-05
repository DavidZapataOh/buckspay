import {
  type Attester,
  checkU32,
  type Liability,
  MAX_NOTE_LIFE,
  type Owner,
  type Receiver,
  U64_MAX,
} from '../../protocol'

/** A note must have at least this long left when it is accepted, so its holder can spend or settle it. */
export const MIN_WINDOW = 24 * 60 * 60

export type AcceptanceOptions = {
  noteDomain: Uint8Array
  ticketDomain: Uint8Array
  program: Uint8Array
  me: Owner
  now: number
  /** The attesters the wallet trusts, as of its last registry sync, with what it relies on each. */
  attesters: Attester[]
  /** At most `MAX_NOTE_LIFE`: a longer note can outlive the attester's exit delay. */
  maxNoteLife?: number
}

/**
 * The one place that says what this wallet accepts: the receiver `verifyPayment` and every screen
 * that previews a payment are built from it.
 */
export function acceptancePolicy({ maxNoteLife = MAX_NOTE_LIFE, ...options }: AcceptanceOptions): Receiver {
  checkU32(maxNoteLife)
  if (maxNoteLife > MAX_NOTE_LIFE) throw new RangeError('maxNoteLife is above what an attester exit covers')
  return {
    ...options,
    minWindow: MIN_WINDOW,
    maxNoteLife,
    acceptCategory: false,
    acceptAuthorities: [],
  }
}

type Reliance = Record<string, string>

/**
 * What the wallet has accepted on each attester's word and not yet seen settled. A payment counts once
 * per attester that vouched for any of its locks, by the amount the wallet receives.
 */
export class AttesterLedger {
  private amounts = new Map<number, bigint>()

  static fromJSON(data: Reliance): AttesterLedger {
    const ledger = new AttesterLedger()
    for (const [id, amount] of Object.entries(data)) ledger.amounts.set(Number(id), BigInt(amount))
    return ledger
  }

  toJSON(): Reliance {
    return Object.fromEntries([...this.amounts].map(([id, amount]) => [String(id), amount.toString()]))
  }

  relied(attester: number): bigint {
    return this.amounts.get(attester) ?? 0n
  }

  /** Records a payment of `amount` accepted on the strength of `liable`. */
  accepted(amount: bigint, liable: Liability[]) {
    for (const id of new Set(liable.map((lock) => lock.attester))) {
      const total = this.relied(id) + amount
      this.amounts.set(id, total > U64_MAX ? U64_MAX : total)
    }
  }

  /** Records that `amount` of a payment settled or expired. */
  settled(amount: bigint, liable: Liability[]) {
    for (const id of new Set(liable.map((lock) => lock.attester))) {
      const left = this.relied(id)
      this.amounts.set(id, left > amount ? left - amount : 0n)
    }
  }

  /** The attesters with what this wallet relies on each filled in. */
  apply(attesters: Attester[]): Attester[] {
    return attesters.map((attester) => ({ ...attester, relied: this.relied(attester.id) }))
  }
}
