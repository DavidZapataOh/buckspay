/** The gateway refused a request, with the HTTP status it answered. */
export class GatewayError extends Error {
  readonly status: number
  /** What else the answer said: a refusal of a settlement carries the time it fits, the minimum, the content on record. */
  readonly body: Record<string, unknown>
  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.body = body
  }
}

/**
 * Whether the gateway itself answered that it did not send a submitted transaction. Any other
 * answer, such as a proxy's `502` or no answer at all, leaves it unknown.
 */
export const notSent = (error: unknown) =>
  error instanceof GatewayError && [400, 409, 410, 422, 429, 503].includes(error.status)

/** How long the app waits for the gateway to answer a request. */
export const GATEWAY_TIMEOUT_MS = 10_000

/** What a sponsored onboarding costs and requires now; amounts are in base units of the mint. */
export type Quote = {
  available: boolean
  fee: bigint
  feeMode: 'off' | 'cost_plus'
  minFunding: bigint
  /** How much of the sponsor's capacity is in use, in percent. */
  pressure: number
  maxLockDays: number
  /** Why `available` is false. */
  reason: string | null
}

/** What the gateway answers when it prepares a sponsored transaction. */
export type Prepared = {
  /** The unsigned transaction, base64. */
  transaction: string
  feePayer: string
  blockhash: string
  computeUnitLimit: number
  computeUnitPrice: number
  /** The fee the transaction pays the sponsor. */
  sponsorFee: bigint
}

/** The sponsored operations; each prepares on its own route and the rotations share one to submit. */
export type OperationKind = 'onboard' | 'lock' | 'withdrawal' | 'rotation-request' | 'rotation-cancel'

const ROUTES: Record<OperationKind, { prepare: string; submit: string }> = {
  onboard: { prepare: '/v1/onboard', submit: '/v1/onboard/submit' },
  lock: { prepare: '/v1/locks', submit: '/v1/locks/submit' },
  withdrawal: { prepare: '/v1/withdrawals', submit: '/v1/withdrawals/submit' },
  'rotation-request': { prepare: '/v1/rotations/request', submit: '/v1/rotations/submit' },
  'rotation-cancel': { prepare: '/v1/rotations/cancel', submit: '/v1/rotations/submit' },
}

export type RotationPending = { pending: false } | { pending: true; wallet: string; effectiveAt: number }

/** What a sponsored settlement costs the sponsor, quoted before a note is sent; the minimum is in base units. */
export type SettlementQuote = {
  /** The smallest amount per record the gateway sponsors now. */
  minAmount: bigint
  /** How much of the sponsor's capacity is in use, in percent. */
  pressure: number
  openRecords: number
  locks: number
}

/** A chain to settle, in the wire formats of the protocol: hex. */
export type SettlementRequest = { issue: string; spends: string[] }

/** A reclaim of one output of a chain, with the owner's signature over the reclaim and its deadline. */
export type ReclaimRequest = SettlementRequest & { owner: string; which: 0 | 1; deadline: number; signature: string }

/** The gateway sent the transaction, or the last record of the chain was paid already. */
export type SettlementAnswer = { signature: string } | { status: 'settled' }

/** The gateway filed the claim, or the loss was claimed already. */
export type ClaimAnswer = { signature: string } | { status: 'claimed' }

/** Buckspay's gateway, which pays for onboarding, locks, withdrawals and rotations the wallet signs. */
export type Gateway = {
  quote(): Promise<Quote>
  prepare(kind: OperationKind, request: Record<string, unknown>): Promise<Prepared>
  submit(kind: OperationKind, request: { key: string; transaction: string }): Promise<{ signature: string }>
  rotationPending(key: string): Promise<RotationPending>
}

/** What the gateway does with notes: it pays for settling and reclaiming them. */
export type SettlementGateway = {
  settlementQuote(): Promise<SettlementQuote>
  /** Settles a chain with no wallet signature: the device signatures in it are the authority. */
  settle(request: SettlementRequest): Promise<SettlementAnswer>
  /** Takes back an output nobody settled, paying the wallet the owner's key is bound to. */
  reclaim(request: ReclaimRequest): Promise<SettlementAnswer>
  /** Files the loss a chain proves, with no signature and nothing paid to anybody: the payer's bond burns. */
  claim(request: SettlementRequest): Promise<ClaimAnswer>
}

export function createGateway(url: string): Gateway & SettlementGateway {
  async function call<T>(path: string, body?: unknown): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS)
    try {
      const response = await fetch(`${url}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const json = await response.json().catch(() => null)
      if (!response.ok) {
        throw new GatewayError(
          response.status,
          typeof json?.error === 'string' ? json.error : response.statusText,
          json && typeof json === 'object' ? json : {},
        )
      }
      return json as T
    } finally {
      clearTimeout(timeout)
    }
  }
  return {
    async quote() {
      const quote = await call<Omit<Quote, 'fee' | 'minFunding'> & { fee: string; minFunding: string }>(
        '/v1/onboarding/quote',
      )
      return { ...quote, fee: BigInt(quote.fee), minFunding: BigInt(quote.minFunding) }
    },
    async prepare(kind, request) {
      const prepared = await call<Omit<Prepared, 'sponsorFee'> & { sponsorFee: string }>(ROUTES[kind].prepare, request)
      return { ...prepared, sponsorFee: BigInt(prepared.sponsorFee) }
    },
    submit: (kind, request) => call(ROUTES[kind].submit, request),
    rotationPending: (key) => call(`/v1/rotations/pending?key=${key}`),
    async settlementQuote() {
      const quote = await call<Omit<SettlementQuote, 'minAmount'> & { minAmount: string }>('/v1/settlements/quote')
      return { ...quote, minAmount: BigInt(quote.minAmount) }
    },
    settle: (request) => call('/v1/settlements', request),
    reclaim: (request) => call('/v1/reclaims', request),
    claim: (request) => call('/v1/fraud/claim', request),
  }
}

/** The gateway of this build, fixed when its bundle is made; builds without one pay from the wallet. */
export const BUILD_GATEWAY = process.env.EXPO_PUBLIC_GATEWAY_URL
  ? createGateway(process.env.EXPO_PUBLIC_GATEWAY_URL)
  : undefined
