import { createSolanaDevnet, createSolanaLocalnet, type SolanaCluster } from '@wallet-ui/react-native-kit'
import type { Cluster } from '../../keys'

/** The one network a build talks to, the cluster its device key signs for, and how the app names it. */
export type BuildNetwork = { cluster: Cluster; label: string; network: SolanaCluster }

/**
 * The network of a build, fixed when its bundle is made: devnet, or for end-to-end test builds a
 * local validator running the devnet build of the program, so `localnet` signs for devnet.
 */
export function getBuildNetwork(name = 'devnet'): BuildNetwork {
  switch (name) {
    case 'devnet':
      return { cluster: 'devnet', label: 'Devnet · test network', network: createSolanaDevnet() }
    case 'localnet':
      return {
        cluster: 'devnet',
        label: 'Local validator · test network',
        network: createSolanaLocalnet({ url: 'http://localhost:8899' }),
      }
    default:
      throw new Error(`Unknown network: ${name}`)
  }
}

export const BUILD_NETWORK = getBuildNetwork(process.env.EXPO_PUBLIC_NETWORK)
