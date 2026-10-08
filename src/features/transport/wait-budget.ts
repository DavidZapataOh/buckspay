import { NEARBY_WAIT_MS } from '../../transport/nearby/transport'
import type { TransportId } from '../../transport/types'

/** How long a wait for the other phone may last on this medium; none where the medium has its own timer. */
export const waitBudget = (id: TransportId): number | undefined => (id === 'nearby' ? NEARBY_WAIT_MS : undefined)
