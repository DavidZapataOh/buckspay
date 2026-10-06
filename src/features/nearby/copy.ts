import type { PairingFailure } from '../../transport/nearby/pairing'

export const nearbyCopy = {
  needsPermission: 'Pay nearby needs Bluetooth and permission to find nearby devices.',
  needsLocation:
    'Android asks for location to find Bluetooth devices on this version. Buckspay never reads or stores your location.',
  allow: 'Allow',
  bluetoothOff: 'Turn on Bluetooth to pay nearby.',
  openBluetooth: 'Open Bluetooth settings',
  unsupported: 'Paying nearby is not available on this phone. Use NFC or a code.',
  hostTitle: 'Nearby code',
  hostHint: 'Ask the payer to pick this code.',
  searching: 'Looking for receivers nearby…',
  noneFound: 'No receiver found. Check that the other phone shows Nearby code and is close.',
  confirm: 'Does {digits} match the other phone?',
  match: 'They match',
  mismatch: 'They don\x27t match',
  secondsLeft: '{seconds} s left',
  tryAgain: 'Try again',
} as const

const FAILED: Record<PairingFailure, string> = {
  Declined: 'Not connected. Start again.',
  Rejected: 'Not connected. Start again.',
  Timeout: 'Took too long. Start again.',
  Busy: 'Not connected. Start again.',
  RadioOff: 'Bluetooth stopped working. Turn it off and on, then try again.',
  Permission: 'Pay nearby needs Bluetooth and permission to find nearby devices.',
  Unsupported: 'Paying nearby is not available on this phone. Use NFC or a code.',
  Error: 'Bluetooth stopped working. Turn it off and on, then try again.',
}

export const failureText = (reason: PairingFailure) => FAILED[reason]

/** The digits as separate words, so a screen reader says "four, eight, two, one". */
export const spokenDigits = (digits: string) => [...digits].join(', ')
