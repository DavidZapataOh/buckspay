import {
  SolanaMobileWalletAdapterError,
  SolanaMobileWalletAdapterErrorCode,
  SolanaMobileWalletAdapterProtocolError,
  SolanaMobileWalletAdapterProtocolErrorCode,
} from '@solana-mobile/mobile-wallet-adapter-protocol'
import type { GetSignatureStatusesApi, Rpc } from '@solana/kit'
import { i18n } from '../../i18n'
import { formatError } from '../../utils/format-error'
import { GatewayError, notDelivered, notSent } from './gateway'
import { METHOD_NOT_FOUND, SponsorshipError } from './gateway-onboard'
import type { Operation } from './operations'
import {
  type PerformContext,
  performSelfPaid,
  performSponsored,
  TransactionRejected,
  waitForSignature,
} from './perform'

const say = (...parts: string[]) => parts.join(' ')
const nothingSent = () => i18n.t('lock:problem.nothingSent')
const sponsorFallback = (reason: SponsorshipError['reason']) => i18n.t(`lock:problem.sponsor.${reason}`)

/** The wallet rejected the cached authorization or closed the session unanswered: connect it again. */
const isStaleAuthorization = (error: unknown) =>
  (error instanceof SolanaMobileWalletAdapterProtocolError &&
    error.code === SolanaMobileWalletAdapterProtocolErrorCode.ERROR_AUTHORIZATION_FAILED) ||
  (error instanceof SolanaMobileWalletAdapterError &&
    (error.code === SolanaMobileWalletAdapterErrorCode.ERROR_SESSION_CLOSED ||
      error.code === SolanaMobileWalletAdapterErrorCode.ERROR_SESSION_TIMEOUT))

const reconnect = () => i18n.t('lock:problem.reconnect')

/** What running an operation needs: the wallet, the gateway and an RPC that reports signature statuses. */
export type RunContext = PerformContext & { rpc: PerformContext['rpc'] & Rpc<GetSignatureStatusesApi> }

export type OperationOutcome =
  | { status: 'done'; signature: string }
  | { status: 'failed'; error: string; details?: string; payInstead: boolean; reconnect?: boolean }

/** What went wrong with an operation, in words that say whether anything was sent or charged. */
export function describeOperationError(error: unknown): Extract<OperationOutcome, { status: 'failed' }> {
  const details = formatError(error)
  if (error instanceof SponsorshipError) {
    if (error.reason === 'unsigned' && isStaleAuthorization(error.cause)) {
      return { status: 'failed', error: say(reconnect(), nothingSent()), details, payInstead: false, reconnect: true }
    }
    return {
      status: 'failed',
      error: say(sponsorFallback(error.reason), nothingSent()),
      details: error.cause ? formatError(error.cause) : details,
      payInstead: true,
    }
  }
  if (error instanceof TransactionRejected) {
    const custom = JSON.stringify(error.error, (_, item) => (typeof item === 'bigint' ? Number(item) : item))
    return {
      status: 'failed',
      error: say(i18n.t('lock:problem.wouldReject'), nothingSent()),
      details: custom,
      payInstead: false,
    }
  }
  if (
    error instanceof SolanaMobileWalletAdapterProtocolError &&
    error.code === SolanaMobileWalletAdapterProtocolErrorCode.ERROR_NOT_SIGNED
  ) {
    return { status: 'failed', error: say(i18n.t('lock:problem.declined'), nothingSent()), details, payInstead: false }
  }
  if (isStaleAuthorization(error)) {
    return { status: 'failed', error: say(reconnect(), nothingSent()), details, payInstead: false, reconnect: true }
  }
  if (notDelivered(error)) {
    return {
      status: 'failed',
      error: say(i18n.t('lock:problem.cantReachBuckspay'), nothingSent(), i18n.t('lock:problem.checkConnection')),
      details,
      payInstead: false,
    }
  }
  if (error instanceof TypeError) {
    return {
      status: 'failed',
      error: i18n.t('lock:problem.cantReachBoth'),
      details,
      payInstead: false,
    }
  }
  return {
    status: 'failed',
    error: i18n.t('lock:problem.incomplete'),
    details,
    payInstead: false,
  }
}

/**
 * Runs `operation` once: through the gateway when `sponsored`, otherwise with the wallet paying. A
 * sponsored operation the gateway cannot take, or the wallet cannot sign for it, is reported with
 * `payInstead` so the screen can offer the wallet paying; nothing was sent then.
 */
export async function runOperation(
  ctx: RunContext,
  operation: Operation,
  sponsored: boolean,
): Promise<OperationOutcome> {
  let signature: string
  try {
    signature = await (sponsored ? performSponsored(ctx, operation) : performSelfPaid(ctx, operation))
  } catch (error) {
    if (error instanceof SolanaMobileWalletAdapterProtocolError && error.code === METHOD_NOT_FOUND) {
      return describeOperationError(new SponsorshipError('unsupported', error))
    }
    if (sponsored && error instanceof GatewayError && error.body.retry === true) {
      return {
        status: 'failed',
        error: say(i18n.t('lock:problem.slow'), nothingSent(), i18n.t('common:tryAgain')),
        details: formatError(error),
        payInstead: false,
      }
    }
    if (sponsored && notSent(error)) {
      return describeOperationError(new SponsorshipError('unavailable', error))
    }
    return describeOperationError(error)
  }
  const failed = await waitForSignature(ctx.rpc, signature)
  if (failed) {
    return {
      status: 'failed',
      error: i18n.t('lock:problem.rejected'),
      details: JSON.stringify(failed, (_, item) => (typeof item === 'bigint' ? Number(item) : item)),
      payInstead: false,
    }
  }
  if (failed === undefined) {
    return {
      status: 'failed',
      error: i18n.t('lock:problem.unconfirmed'),
      payInstead: false,
    }
  }
  return { status: 'done', signature }
}
