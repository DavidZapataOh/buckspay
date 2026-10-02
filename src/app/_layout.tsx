import '../global.css'

import { Stack } from 'expo-router'
import { AppIdentity, MobileWalletProvider } from '@wallet-ui/react-native-kit'
import { useEffect, useRef } from 'react'
import { AccessibilityInfo } from 'react-native'
import { DeviceIdentityProvider, useDeviceIdentity } from '../features/identity/use-device-identity'
import { BUILD_NETWORK } from '../features/network/build-network'
import { NetworkProvider } from '../features/network/network-provider'
import { createAuthorizationCache } from '../features/wallet/authorization-cache'
import { configureDeviceKey } from '../keys'

// Created once, outside render: a new cache would make the wallet provider start over.
const cache = createAuthorizationCache(BUILD_NETWORK.network.id)
const identity: AppIdentity = { name: 'Buckspay', uri: 'https://buckspay.xyz', icon: 'favicon.png' }

configureDeviceKey(BUILD_NETWORK.cluster)

export default function Layout() {
  return (
    <NetworkProvider network={BUILD_NETWORK.network}>
      <MobileWalletProvider cache={cache} cluster={BUILD_NETWORK.network} identity={identity}>
        <DeviceIdentityProvider build={BUILD_NETWORK} cache={cache}>
          <Routes />
        </DeviceIdentityProvider>
      </MobileWalletProvider>
    </NetworkProvider>
  )
}

// The app opens without onboarding; paying and receiving open it until the device is `ready`.
function Routes() {
  const { step } = useDeviceIdentity()
  const previous = useRef(step)
  // Onboarding closes itself once the registration is confirmed: say so to screen readers.
  useEffect(() => {
    if (step === 'ready' && previous.current === 'confirming') {
      AccessibilityInfo.announceForAccessibility('This phone is registered to your wallet.')
    }
    previous.current = step
  }, [step])
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Protected guard={step !== 'ready'}>
        <Stack.Screen name="onboarding" options={{ presentation: 'modal' }} />
      </Stack.Protected>
    </Stack>
  )
}
