import { nearbyCopy } from '../nearby/copy'
import type { Availability, TransportId } from '../../transport/types'

export const howCopy = {
  labels: { qr: 'Code', nfc: 'Tap', nearby: 'Nearby' },
  hints: {
    nfc: {
      disabled: 'Turn on NFC to pay by tapping phones.',
      'permission-denied': 'Allow NFC to pay by tapping phones.',
    },
    nearby: { disabled: nearbyCopy.bluetoothOff, 'permission-denied': nearbyCopy.needsPermission },
  },
  fix: {
    nfc: 'Open NFC settings',
    bluetooth: nearbyCopy.openBluetooth,
    allow: nearbyCopy.allow,
    permission: 'Open app settings',
  },
  waiting: { nfc: 'Hold the phones together', nearby: 'Waiting for the other phone' },
  waitingForRequest: 'Waiting for the request',
} as const

type Off = Extract<Availability, { ready: false }>['reason']

/** The one-line explanation of a medium that is off and can be turned on; none when nothing can be done. */
export function hintFor(id: TransportId, reason: Off): string | undefined {
  if (id === 'qr' || (reason !== 'disabled' && reason !== 'permission-denied')) return undefined
  return howCopy.hints[id][reason]
}
