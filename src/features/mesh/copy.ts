export const meshCopy = {
  title: 'Nearby payments',
  body: 'Buckspay uses Bluetooth to find phones nearby, pass on warnings about cheating and hand payments to a phone with internet. It never shares your balance or where you are.',
  allow: 'Allow',
  continue: 'Continue',
  footnote: 'You can turn this off in Settings.',
  switch: 'Help nearby payments',
  status: {
    on: 'On',
    off: 'Off',
    bluetoothOff: 'Bluetooth is off',
    permissionNeeded: 'Permission needed',
    unsupported: 'Not available on this phone',
  },
  warnings: (count: number) => `Warnings received: ${count}`,
  passedOn: (count: number) => `Payments passed on: ${count}`,
  turnOn: 'Turn on',
  openSettings: 'Open settings',
} as const
