import '../global.css'

import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as SplashScreen from 'expo-splash-screen'
import * as SystemUI from 'expo-system-ui'
import { AppIdentity, MobileWalletProvider } from '@wallet-ui/react-native-kit'
import { useEffect, useRef } from 'react'
import { AccessibilityInfo } from 'react-native'
import { DeviceIdentityProvider, useDeviceIdentity } from '../features/identity/use-device-identity'
import { BUILD_NETWORK } from '../features/network/build-network'
import { NetworkProvider } from '../features/network/network-provider'
import { PayFlowProvider } from '../features/pay/use-pay-flow'
import { PaymentsProvider } from '../features/payment/payments-provider'
import { ReceiveFlowProvider } from '../features/receive/use-receive-flow'
import { SettlementProvider } from '../features/settlement/use-settlement-runner'
import { createAuthorizationCache } from '../features/wallet/authorization-cache'
import { configureDeviceKey } from '../keys'
import { useThemeColors } from '../theme/use-theme-colors'

// Created once, outside render: a new cache would make the wallet provider start over.
const cache = createAuthorizationCache(BUILD_NETWORK.network.id)
// Wallets verify this origin against the app's signing certificate through its Digital Asset Links file.
const identity: AppIdentity = {
  name: 'Buckspay',
  uri: process.env.EXPO_PUBLIC_APP_IDENTITY_URI ?? 'https://buckspay.xyz',
  icon: 'favicon.png',
}

configureDeviceKey(BUILD_NETWORK.cluster)
// Expo Router hides the splash on the first frame of the app; hand over to it without a fade.
SplashScreen.setOptions({ duration: 0 })

export default function Layout() {
  return (
    <NetworkProvider network={BUILD_NETWORK.network}>
      <MobileWalletProvider cache={cache} cluster={BUILD_NETWORK.network} identity={identity}>
        <DeviceIdentityProvider build={BUILD_NETWORK} cache={cache}>
          <PaymentsProvider>
            <SettlementProvider>
              <PayFlowProvider>
                <ReceiveFlowProvider>
                  <Routes />
                </ReceiveFlowProvider>
              </PayFlowProvider>
            </SettlementProvider>
          </PaymentsProvider>
        </DeviceIdentityProvider>
      </MobileWalletProvider>
    </NetworkProvider>
  )
}

// The app opens without onboarding; paying and receiving open it until the device is `ready`.
function Routes() {
  const { step } = useDeviceIdentity()
  const [background] = useThemeColors('background')
  const previous = useRef(step)
  // The window behind every screen follows the theme, so no light frame shows in dark mode.
  useEffect(() => {
    if (background) void SystemUI.setBackgroundColorAsync(background)
  }, [background])
  // Onboarding closes itself once the registration is confirmed: say so to screen readers.
  useEffect(() => {
    if (step === 'ready' && previous.current === 'confirming') {
      AccessibilityInfo.announceForAccessibility('This phone is activated and registered to your wallet.')
    }
    previous.current = step
  }, [step])
  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: background } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Protected guard={step !== 'ready'}>
          <Stack.Screen name="onboarding" options={{ presentation: 'modal' }} />
        </Stack.Protected>
        <Stack.Protected guard={step === 'ready'}>
          <Stack.Screen name="add-funds" options={{ presentation: 'modal' }} />
          <Stack.Screen name="withdraw" options={{ presentation: 'modal' }} />
          <Stack.Screen name="pay" />
          <Stack.Screen name="nearby" />
          <Stack.Screen name="receive/session" />
          <Stack.Screen name="activity/[id]" />
        </Stack.Protected>
        <Stack.Screen name="reset-identity" />
      </Stack>
    </>
  )
}
