/** Every sentence of the nearby check. None of them claims more than that one phone heard the other. */
export const witnessCopy = {
  willAsk: 'This sale will ask the other phone for a nearby check.',
  receiverChecking: 'Listening for the other phone. Keep the phones together, up to 30 seconds.',
  payerChecking: 'Listening for the other phone. You can leave this screen.',
  seen: 'Heard the other phone nearby.',
  notSeen: "Didn't hear the other phone nearby.",
  unavailable: 'The nearby check is off. Turn on the microphone for Buckspay in Settings.',
  skipped: 'Nearby check skipped.',
  requiredChecking: 'Received. Checking that the other phone is nearby…',
  requiredNotSeen: "Received, but the other phone wasn't heard nearby. The payment is final.",
  skip: 'Skip',
  tryAgain: 'Try again',
  whatThisMeans: 'What this means',
  openSettings: 'Open Settings',
  continueAnyway: 'Continue anyway',
  meaning:
    'This phone played a short sound and the other phone answered it, within a few seconds of the payment. It does not show how far apart the phones were, or that nobody passed the sound along. The payment is final either way.',
  reviewAsks: 'The receiver will ask for a nearby check after you pay. This uses the microphone and records nothing.',
  allow: 'Allow',
  settings: {
    title: 'Nearby check',
    answer: 'Answer nearby checks',
    ask: 'Ask for a nearby check',
    requireFrom: 'Wait for the check from',
    audible: 'Use audible beeps',
    footnote: 'A short high-pitched sound some people can hear. Nothing is recorded.',
  },
} as const
