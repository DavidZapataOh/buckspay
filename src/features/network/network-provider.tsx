import { SolanaCluster, SolanaClusterId } from '@wallet-ui/react-native-kit'
import { createContext, ReactNode, useMemo } from 'react'

export interface NetworkProviderContextValue {
  chain: SolanaClusterId
  endpoint: string
  getExplorerUrl(path: string): string
  network: SolanaCluster
}

export const NetworkProviderContext = createContext<NetworkProviderContextValue>({} as NetworkProviderContextValue)

/** Provides the one network this build talks to. */
export function NetworkProvider({ network, children }: { network: SolanaCluster; children: ReactNode }) {
  const value = useMemo(
    () => ({
      chain: network.id,
      endpoint: network.url,
      getExplorerUrl: (path: string) => `https://explorer.solana.com/${path}${getExplorerUrlParam(network)}`,
      network,
    }),
    [network],
  )
  return <NetworkProviderContext.Provider value={value}>{children}</NetworkProviderContext.Provider>
}

function getExplorerUrlParam(network: SolanaCluster): string {
  switch (network.id) {
    case 'solana:devnet':
      return `?cluster=devnet`
    case 'solana:localnet':
      return `?cluster=custom&customUrl=${encodeURIComponent(network.url)}`
    default:
      return ''
  }
}
