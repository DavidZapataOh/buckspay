/** The gateway refused a request, with the HTTP status it answered. */
export class GatewayError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
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

/** Buckspay's gateway, which pays for onboarding, locks, withdrawals and rotations the wallet signs. */
export type Gateway = {
  quote(): Promise<Quote>
  prepare(kind: OperationKind, request: Record<string, unknown>): Promise<Prepared>
  submit(kind: OperationKind, request: { key: string; transaction: string }): Promise<{ signature: string }>
  rotationPending(key: string): Promise<RotationPending>
}

export function createGateway(url: string): Gateway {
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
        throw new GatewayError(response.status, typeof json?.error === 'string' ? json.error : response.statusText)
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
  }
}

/** The gateway of this build, fixed when its bundle is made; builds without one pay from the wallet. */
export const BUILD_GATEWAY = process.env.EXPO_PUBLIC_GATEWAY_URL
  ? createGateway(process.env.EXPO_PUBLIC_GATEWAY_URL)
  : undefined
