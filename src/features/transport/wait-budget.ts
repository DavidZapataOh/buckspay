import { NEARBY_WAIT_MS, RECEIPT_WAIT_MS } from '../../transport/nearby/transport'
import type { TransportId } from '../../transport/types'

/** How long a payer waits for the receiver's request; none where the medium has its own timer. */
export const waitBudget = (id: TransportId): number | undefined => (id === 'nearby' ? NEARBY_WAIT_MS : undefined)

/** How long a payer waits for the confirmation after sending the payment. */
export const receiptBudget = (id: TransportId): number | undefined => (id === 'nearby' ? RECEIPT_WAIT_MS : undefined)

/** How long a receiver waits for the payment: as long as the request is valid (Unix seconds). */
export const untilExpiry = (id: TransportId, expiresAt: number): number | undefined =>
  id === 'nearby' ? Math.max(0, expiresAt * 1000 - Date.now()) : undefined
