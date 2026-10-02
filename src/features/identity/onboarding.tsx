import { openURL } from 'expo-linking'
import { router } from 'expo-router'
import { useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useNetwork } from '../network/use-network'
import { confirmingNotice, costNotice, keyProtection, shortfallNotice, stepCopy } from './identity-copy'
import { useDeviceIdentity } from './use-device-identity'

/** Sets up paying and receiving: a wallet, this phone's key and its registration. */
export function Onboarding() {
  const insets = useSafeAreaInsets()
  const { getExplorerUrl } = useNetwork()
  const { step, busy, error, details, signature, quote, wallet, device, deviceKey, next } = useDeviceIdentity()
  const [showDetails, setShowDetails] = useState(false)
  // While loading, the screen shows a spinner, or a retry once the derivation failed.
  const content = step === 'ready' || (step === 'loading' && !error) ? undefined : stepCopy[step]
  const notice =
    step === 'confirming'
      ? confirmingNotice(signature)
      : step === 'register' && quote
        ? shortfallNotice(quote)
        : undefined

  return (
    <View
      className="flex-1 bg-white dark:bg-black px-8"
      style={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 }}
    >
      <Pressable
        testID="onboarding-close"
        accessibilityRole="button"
        onPress={() => router.back()}
        className="self-start py-3 mb-8"
      >
        <Text className="text-base text-gray-900 dark:text-white">Close</Text>
      </Pressable>
      {content ? (
        <View testID={`onboarding-${step}`} className="flex-1">
          {content.progress ? (
            <Text testID="onboarding-progress" className="text-sm text-gray-500 dark:text-gray-400 mb-1">
              {content.progress}
            </Text>
          ) : null}
          <Text accessibilityRole="header" className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
            {content.title}
          </Text>
          <Text className="text-base text-gray-600 dark:text-gray-300 mb-6">{content.body}</Text>
          {step === 'register' && quote ? (
            <Text testID="registration-cost" className="text-base text-gray-900 dark:text-white mb-2">
              {costNotice(quote)}
            </Text>
          ) : null}
          {step === 'other-wallet' && device ? (
            <Text testID="registered-wallet" selectable className="text-sm text-gray-500 dark:text-gray-400 mb-1">
              Registered to {device.wallet}
            </Text>
          ) : null}
          {wallet ? (
            <Text testID="wallet-address" selectable className="text-sm text-gray-500 dark:text-gray-400 mb-1">
              {wallet}
            </Text>
          ) : null}
          {deviceKey ? (
            <Text testID="security-level" className="text-sm text-gray-500 dark:text-gray-400 mb-1">
              Key protection: {keyProtection[deviceKey.securityLevel]}
            </Text>
          ) : null}
          <Text
            testID="onboarding-notice"
            accessibilityLiveRegion="polite"
            className="text-base text-gray-900 dark:text-white mt-4"
          >
            {notice ?? ''}
          </Text>
          <Text
            testID="onboarding-error"
            accessibilityLiveRegion="polite"
            className="text-sm text-red-600 dark:text-red-400 mt-4"
          >
            {error ?? ''}
          </Text>
          {details ? (
            <Pressable
              testID="onboarding-details"
              accessibilityRole="button"
              accessibilityState={{ expanded: showDetails }}
              onPress={() => setShowDetails(!showDetails)}
              className="py-3"
            >
              <Text className="text-sm text-gray-900 dark:text-white underline">Details</Text>
            </Pressable>
          ) : null}
          {showDetails && details ? (
            <Text selectable className="text-sm text-gray-500 dark:text-gray-400">
              {details}
            </Text>
          ) : null}
          {signature && (step === 'confirming' || showDetails) ? (
            <Pressable
              accessibilityRole="link"
              onPress={() => void openURL(getExplorerUrl(`tx/${signature}`))}
              className="py-3"
            >
              <Text className="text-sm text-gray-900 dark:text-white underline">
                View the transaction in the explorer
              </Text>
            </Pressable>
          ) : null}
          <View className="flex-1" />
          {step === 'confirming' && !error ? (
            <ActivityIndicator testID="onboarding-waiting" accessibilityLabel="Waiting for Solana" />
          ) : (
            <Pressable
              testID="onboarding-next"
              accessibilityRole="button"
              accessibilityLabel={content.action}
              accessibilityState={{ busy, disabled: busy }}
              disabled={busy}
              onPress={() => void next()}
              className={`py-4 rounded-full items-center ${busy ? 'bg-gray-400' : 'bg-gray-900 dark:bg-white'}`}
            >
              {busy ? (
                <ActivityIndicator accessibilityLabel="Working" color="white" />
              ) : (
                <Text className="text-white dark:text-black text-base font-semibold">{content.action}</Text>
              )}
            </Pressable>
          )}
        </View>
      ) : (
        <ActivityIndicator testID="onboarding-loading" accessibilityLabel="Checking this phone" />
      )}
    </View>
  )
}
