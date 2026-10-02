import { StatusBar } from 'expo-status-bar'
import { useState } from 'react'
import { Text, View, Pressable } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { BUCKSPAY_PROGRAM_ADDRESS } from '@project/anchor'
import { AppAddressLink } from '../components/app-address-link'
import { NetworkUiSelect } from '../features/network/network-ui-select'
import { formatError } from '../utils/format-error'

export default function App() {
  const insets = useSafeAreaInsets()
  const { account, connect, disconnect } = useMobileWallet()
  const [error, setError] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  // Wallet actions can be declined or fail. Run them here so a rejection never
  // escapes as an unhandled promise and the reason ends up on screen.
  async function run(action: () => Promise<unknown>) {
    if (isBusy) {
      return
    }
    setIsBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(formatError(e))
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <View
      className="flex-1 bg-white dark:bg-black items-center px-8"
      style={{ paddingBottom: insets.bottom, paddingTop: insets.top + 64 }}
    >
      <Text className="text-4xl font-extrabold text-gray-800 dark:text-white mb-3 tracking-tight">Buckspay</Text>

      <View className="mb-4">
        <AppAddressLink address={BUCKSPAY_PROGRAM_ADDRESS} label="Program" />
      </View>

      <View className="mb-8 items-center">
        {account ? (
          <View className="items-center">
            <View className="mb-2">
              <AppAddressLink address={account.address.toString()} label="Wallet" />
            </View>
            <Pressable
              disabled={isBusy}
              onPress={() => void run(disconnect)}
              className={`bg-red-500 px-6 py-3 rounded-xl active:bg-red-600 ${isBusy ? 'opacity-50' : ''}`}
            >
              <Text className="text-white font-bold">{isBusy ? 'Working...' : 'Disconnect Wallet'}</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            disabled={isBusy}
            onPress={() => void run(connect)}
            className={`bg-blue-600 px-6 py-3 rounded-xl active:bg-blue-700 ${isBusy ? 'opacity-50' : ''}`}
          >
            <Text className="text-white font-bold text-lg">{isBusy ? 'Working...' : 'Connect Wallet'}</Text>
          </Pressable>
        )}
        {error ? <Text className="text-red-500 mt-3 text-center max-w-sm">{error}</Text> : null}
        <View className="mt-4">
          <NetworkUiSelect />
        </View>
      </View>

      <StatusBar style="auto" />
    </View>
  )
}
