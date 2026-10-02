import { router } from 'expo-router'
import { ActivityIndicator, View } from 'react-native'
import { AddressRow } from '../../components/address-row'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { homeStatus } from '../../features/identity/identity-copy'
import { useDeviceIdentity } from '../../features/identity/use-device-identity'
import { BUILD_NETWORK } from '../../features/network/build-network'
import { useThemeColors } from '../../theme/use-theme-colors'

export default function Home() {
  const identity = useDeviceIdentity()
  const { busy, device, next } = identity
  const status = homeStatus(identity)
  const [primary] = useThemeColors('primary')

  return (
    <Screen testID="home">
      <View testID={status.testID} className="rounded-3xl bg-surface p-5 gap-3">
        <AppText variant="headline">{status.title}</AppText>
        {status.testID === 'home-loading' ? (
          <ActivityIndicator accessibilityLabel="Checking this phone" color={primary} className="self-start" />
        ) : null}
        {status.body ? (
          <AppText variant="body" tone="muted">
            {status.body}
          </AppText>
        ) : null}
        {device ? <AddressRow address={device.wallet} label="Registered to" /> : null}
        {status.action ? (
          <Button
            testID="setup-payments"
            variant="filled"
            label={status.action}
            onPress={() => router.push('/onboarding')}
          />
        ) : null}
        {status.retry ? (
          <Button testID="home-retry" variant="filled" label={status.retry} busy={busy} onPress={() => void next()} />
        ) : null}
      </View>
      <View
        testID="network-chip"
        accessible
        className="self-start min-h-8 px-3 rounded-full border border-outline justify-center"
      >
        <AppText variant="label" tone="muted">
          {BUILD_NETWORK.label}
        </AppText>
      </View>
    </Screen>
  )
}
