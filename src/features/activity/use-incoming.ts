import { getAddressEncoder } from '@solana/kit'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { useNetworkState } from 'expo-network'
import { useEffect, useState } from 'react'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { BUILD_FUNDING_MINT } from '../lock/build-funding'
import { fetchIncoming, type Incoming } from './incoming'

/** What reached this wallet from far away, read from finalized chain data whenever the phone is online. */
export function useIncoming(refreshKey?: unknown): readonly Incoming[] {
  const { device } = useDeviceIdentity()
  const { client } = useMobileWallet()
  const online = useNetworkState().isInternetReachable === true
  const [items, setItems] = useState<readonly Incoming[]>([])
  const wallet = device?.wallet
  useEffect(() => {
    if (!wallet || !online) return
    let current = true
    const encoder = getAddressEncoder()
    void fetchIncoming(
      client.rpc,
      Uint8Array.from(encoder.encode(wallet)),
      Uint8Array.from(encoder.encode(BUILD_FUNDING_MINT)),
    )
      .then((found) => current && setItems(found))
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [wallet, online, client.rpc, refreshKey])
  return items
}
