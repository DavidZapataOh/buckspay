import { address } from '@solana/kit'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { useCallback, useEffect, useState } from 'react'
import { Platform } from 'react-native'
import { ACTIVE_PROFILE } from '../../protocol/active-profile'
import { BUILD_GATEWAY } from '../lock/gateway'
import { proverNative } from './native'
import { BUILD_PINS } from './pins'
import type { PrivateDataProps } from './private-data-row'
import { createKeyResolver, readChainKeys } from './trusted-key'
import type { KeyOffer } from './types'

const PROGRAM_ADDRESS = address(ACTIVE_PROFILE.programId)
const nowSeconds = () => Math.floor(Date.now() / 1000)

/** The state of the private settlement data and the action that downloads it on any network. */
export function usePrivateData(): PrivateDataProps | undefined {
  const { client } = useMobileWallet()
  const [offer, setOffer] = useState<KeyOffer>()
  const [status, setStatus] = useState<Pick<PrivateDataProps, 'state' | 'progress' | 'sizeBytes'>>({
    state: 'unavailable',
    progress: 0,
    sizeBytes: 0,
  })
  const supported = Platform.OS === 'android' && BUILD_GATEWAY !== undefined

  useEffect(() => {
    if (!supported || !BUILD_GATEWAY) return
    const gateway = BUILD_GATEWAY
    let current = true
    const resolve = createKeyResolver({
      zkConfig: () => gateway.zkConfig(),
      readChain: () => readChainKeys(client.rpc, PROGRAM_ADDRESS),
      pins: BUILD_PINS,
      now: nowSeconds,
    })
    const read = async () => {
      const key = await resolve()
      if (!current) return
      setOffer(key)
      if (!key) return setStatus({ state: 'unavailable', progress: 0, sizeBytes: 0 })
      const { state, progress, sizeBytes } = await proverNative.keyStatus(key.vkSha256)
      if (current) setStatus({ state, progress, sizeBytes })
    }
    void read()
    const timer = setInterval(() => void read(), 5_000)
    return () => {
      current = false
      clearInterval(timer)
    }
  }, [supported, client.rpc])

  const onDownload = useCallback(() => {
    if (offer) void proverNative.ensureKey(offer, false)
  }, [offer])
  return supported ? { ...status, onDownload } : undefined
}
