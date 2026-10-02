/** What the gateway answers when it prepares a sponsored registration. */
export type PreparedRegistration = {
  /** The unsigned transaction, base64. */
  transaction: string
  feePayer: string
  blockhash: string
  computeUnitPrice: number
}

/** The gateway refused a request, with the HTTP status it answered. */
export class GatewayError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * Whether the gateway itself answered that it did not send a submitted registration. Any other
 * answer, such as a proxy's `502` or no answer at all, leaves it unknown.
 */
export const notSent = (error: unknown) =>
  error instanceof GatewayError && [400, 409, 410, 422, 429, 503].includes(error.status)

/** How long the app waits for the gateway to answer a request. */
export const GATEWAY_TIMEOUT_MS = 10_000

/** Buckspay's gateway, which pays for registrations the wallet signs. */
export type Gateway = {
  /** Resolves when a registration from this network would be sponsored now. */
  sponsorship(): Promise<void>
  prepare(request: { wallet: string; key: string; signature: string }): Promise<PreparedRegistration>
  submit(request: { key: string; transaction: string }): Promise<{ signature: string }>
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
    sponsorship: () => call<void>('/v1/registrations/sponsorship'),
    prepare: (request) => call('/v1/registrations', request),
    submit: (request) => call('/v1/registrations/submit', request),
  }
}

/** The gateway of this build, fixed when its bundle is made; builds without one register self-paid. */
export const BUILD_GATEWAY = process.env.EXPO_PUBLIC_GATEWAY_URL
  ? createGateway(process.env.EXPO_PUBLIC_GATEWAY_URL)
  : undefined
