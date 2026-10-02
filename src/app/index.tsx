import { router } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AppAddressLink } from '../components/app-address-link'
import { homeStatus } from '../features/identity/identity-copy'
import { useDeviceIdentity } from '../features/identity/use-device-identity'
import { BUILD_NETWORK } from '../features/network/build-network'

export default function Home() {
  const insets = useSafeAreaInsets()
  const identity = useDeviceIdentity()
  const { busy, wallet, device, next, disconnect } = identity
  const status = homeStatus(identity)

  return (
    <View
      testID="home"
      className="flex-1 bg-white dark:bg-black px-8"
      style={{ paddingBottom: insets.bottom, paddingTop: insets.top + 24 }}
    >
      <Text testID="network-chip" className="self-start text-sm text-gray-600 dark:text-gray-300 mb-6">
        {BUILD_NETWORK.label}
      </Text>
      <View testID={status.testID} accessible className="rounded-2xl bg-gray-100 dark:bg-gray-900 p-4 mb-6">
        <Text accessibilityRole="header" className="text-xl font-bold text-gray-900 dark:text-white">
          {status.title}
        </Text>
        {status.body ? <Text className="text-base text-gray-600 dark:text-gray-300 mt-1">{status.body}</Text> : null}
        {status.testID === 'home-loading' ? (
          <ActivityIndicator className="mt-2" accessibilityLabel="Checking this phone" />
        ) : null}
      </View>
      {device ? (
        <View className="mb-4">
          <AppAddressLink address={device.wallet} label="Registered to" />
        </View>
      ) : null}
      {status.action ? (
        <Pressable
          testID="setup-payments"
          accessibilityRole="button"
          onPress={() => router.push('/onboarding')}
          className="self-start bg-gray-900 dark:bg-white px-6 py-3 rounded-full mb-4"
        >
          <Text className="text-white dark:text-black font-semibold">{status.action}</Text>
        </Pressable>
      ) : null}
      {status.retry ? (
        <Pressable
          testID="home-retry"
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void next()}
          className="self-start bg-gray-900 dark:bg-white px-6 py-3 rounded-full mb-4"
        >
          <Text className="text-white dark:text-black font-semibold">{status.retry}</Text>
        </Pressable>
      ) : null}
      {wallet ? (
        <Pressable
          testID="disconnect"
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void disconnect()}
          className={`self-start px-6 py-3 rounded-full border border-gray-300 dark:border-gray-700 ${busy ? 'opacity-50' : ''}`}
        >
          <Text className="text-gray-900 dark:text-white font-semibold">Forget wallet on this phone</Text>
        </Pressable>
      ) : null}
      <StatusBar style="auto" />
    </View>
  )
}
