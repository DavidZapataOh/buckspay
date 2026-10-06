/** The measurement screen exists in end-to-end builds only; the bundler removes it everywhere else. */
export default function NfcLabRoute() {
  if (process.env.EXPO_PUBLIC_E2E !== '1') return null
  // A static import would keep the screen in every bundle; the bundler folds the condition above and drops this require.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NfcLab } = require('../features/nfc/nfc-lab') as typeof import('../features/nfc/nfc-lab')
  return <NfcLab />
}
