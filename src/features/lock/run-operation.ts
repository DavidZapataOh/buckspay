import {
  SolanaMobileWalletAdapterError,
  SolanaMobileWalletAdapterErrorCode,
  SolanaMobileWalletAdapterProtocolError,
  SolanaMobileWalletAdapterProtocolErrorCode,
} from '@solana-mobile/mobile-wallet-adapter-protocol'
import type { GetSignatureStatusesApi, Rpc } from '@solana/kit'
import { formatError } from '../../utils/format-error'
import { GatewayError, notSent } from './gateway'
import { METHOD_NOT_FOUND, SponsorshipError } from './gateway-onboard'
import type { Operation } from './operations'
import {
  type PerformContext,
  performSelfPaid,
  performSponsored,
  TransactionRejected,
  waitForSignature,
} from './perform'

const NOTHING_SENT = 'Nothing was sent and nothing was charged.'

const SPONSOR_FALLBACK: Record<SponsorshipError['reason'], string> = {
  unavailable: 'Buckspay couldn’t pay for this.',
  mismatch: 'Buckspay’s server offered a transaction this app didn’t ask for, so your wallet never saw it.',
  unsupported: 'Your wallet can’t sign a transaction that Buckspay pays for.',
  altered: 'Your wallet changed the transaction before signing it, so it wasn’t sent.',
  unsigned: 'Your wallet couldn’t sign the transaction.',
}

/** The wallet rejected the cached authorization or closed the session unanswered: connect it again. */
const isStaleAuthorization = (error: unknown) =>
  (error instanceof SolanaMobileWalletAdapterProtocolError &&
    error.code === SolanaMobileWalletAdapterProtocolErrorCode.ERROR_AUTHORIZATION_FAILED) ||
  (error instanceof SolanaMobileWalletAdapterError &&
    (error.code === SolanaMobileWalletAdapterErrorCode.ERROR_SESSION_CLOSED ||
      error.code === SolanaMobileWalletAdapterErrorCode.ERROR_SESSION_TIMEOUT))

const RECONNECT = 'Your wallet no longer recognizes Buckspay. Connect it again.'

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
      return { status: 'failed', error: `${RECONNECT} ${NOTHING_SENT}`, details, payInstead: false, reconnect: true }
    }
    return {
      status: 'failed',
      error: `${SPONSOR_FALLBACK[error.reason]} ${NOTHING_SENT}`,
      details: error.cause ? formatError(error.cause) : details,
      payInstead: true,
    }
  }
  if (error instanceof TransactionRejected) {
    const custom = JSON.stringify(error.error, (_, item) => (typeof item === 'bigint' ? Number(item) : item))
    return { status: 'failed', error: `Solana would reject this. ${NOTHING_SENT}`, details: custom, payInstead: false }
  }
  if (
    error instanceof SolanaMobileWalletAdapterProtocolError &&
    error.code === SolanaMobileWalletAdapterProtocolErrorCode.ERROR_NOT_SIGNED
  ) {
    return { status: 'failed', error: `You declined in your wallet. ${NOTHING_SENT}`, details, payInstead: false }
  }
  if (isStaleAuthorization(error)) {
    return { status: 'failed', error: `${RECONNECT} ${NOTHING_SENT}`, details, payInstead: false, reconnect: true }
  }
  if (error instanceof TypeError) {
    return {
      status: 'failed',
      error:
        'Can’t reach Solana or Buckspay. Check your connection. The transaction may not have been sent; check before trying again.',
      details,
      payInstead: false,
    }
  }
  return {
    status: 'failed',
    error: 'The transaction didn’t complete. It may or may not have been sent; check before trying again.',
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
        error: `Solana was slow to see the transaction. ${NOTHING_SENT} Try again.`,
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
      error: 'Solana rejected the transaction. No funds moved.',
      details: JSON.stringify(failed, (_, item) => (typeof item === 'bigint' ? Number(item) : item)),
      payInstead: false,
    }
  }
  if (failed === undefined) {
    return {
      status: 'failed',
      error: 'Solana hasn’t confirmed the transaction yet. It may still land; check your locks in a minute.',
      payInstead: false,
    }
  }
  return { status: 'done', signature }
}
