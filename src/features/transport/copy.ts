import { i18n } from '../../i18n'
import type { Availability, TransportId } from '../../transport/types'

type Off = Extract<Availability, { ready: false }>['reason']

/** The one-line explanation of a medium that is off and can be turned on; none when nothing can be done. */
export function hintFor(id: TransportId, reason: Off): string | undefined {
  if (id === 'qr' || (reason !== 'disabled' && reason !== 'permission-denied')) return undefined
  return i18n.t(`transport:hints.${id}.${reason}`)
}
