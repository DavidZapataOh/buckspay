/** The measurement screen exists in end-to-end builds only; the bundler removes it everywhere else. */
export default function NearbyLabRoute() {
  if (process.env.EXPO_PUBLIC_E2E !== '1') return null
  // A static import would keep the screen in every bundle; the bundler folds the condition above and drops this require.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NearbyLab } = require('../features/nearby/nearby-lab') as typeof import('../features/nearby/nearby-lab')
  return <NearbyLab />
}
