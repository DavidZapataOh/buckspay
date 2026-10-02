import { openURL } from 'expo-linking'
import { router } from 'expo-router'
import { useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { AddressRow } from '../../components/address-row'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { IconButton } from '../../components/icon-button'
import { Screen } from '../../components/screen'
import { StatusNote } from '../../components/status-note'
import { useThemeColors } from '../../theme/use-theme-colors'
import { useNetwork } from '../network/use-network'
import { confirmingNotice, costNotice, keyProtection, shortfallNotice, stepCopy } from './identity-copy'
import { useDeviceIdentity } from './use-device-identity'

/** Sets up paying and receiving: a wallet, this phone's key and its registration. */
export function Onboarding() {
  const { getExplorerUrl } = useNetwork()
  const { step, busy, error, details, signature, quote, wallet, device, deviceKey, next } = useDeviceIdentity()
  const [showDetails, setShowDetails] = useState(false)
  const [primary] = useThemeColors('primary')
  // While loading, the screen shows a spinner, or a retry once the derivation failed.
  const content = step === 'ready' || (step === 'loading' && !error) ? undefined : stepCopy[step]
  const notice =
    step === 'confirming'
      ? confirmingNotice(signature)
      : step === 'register' && quote
        ? shortfallNotice(quote)
        : undefined

  return (
    <Screen>
      <View className="flex-row items-center justify-between -ml-3">
        <IconButton testID="onboarding-close" icon="close" label="Close" onPress={() => router.back()} />
        {content?.progress ? (
          <AppText testID="onboarding-progress" variant="label" tone="muted">
            {content.progress}
          </AppText>
        ) : null}
      </View>
      {content ? (
        <View testID={`onboarding-${step}`} className="grow gap-4">
          <AppText variant="headline">{content.title}</AppText>
          <AppText variant="body" tone="muted">
            {content.body}
          </AppText>
          {step === 'register' && quote ? (
            <AppText testID="registration-cost" variant="body">
              {costNotice(quote)}
            </AppText>
          ) : null}
          {step === 'other-wallet' && device ? (
            <AddressRow testID="registered-wallet" address={device.wallet} label="Registered to" />
          ) : null}
          {wallet ? (
            <View className="gap-1">
              <AppText variant="label" tone="muted">
                Connected wallet
              </AppText>
              <AppText testID="wallet-address" variant="label" selectable>
                {wallet}
              </AppText>
            </View>
          ) : null}
          {deviceKey ? (
            <AppText testID="security-level" variant="label" tone="muted">
              Key protection: {keyProtection[deviceKey.securityLevel]}
            </AppText>
          ) : null}
          <StatusNote testID="onboarding-notice" tone="default" message={notice} />
          <StatusNote testID="onboarding-error" tone="danger" message={error} />
          {details ? (
            <Button
              testID="onboarding-details"
              variant="text"
              label={showDetails ? 'Hide details' : 'Details'}
              onPress={() => setShowDetails(!showDetails)}
            />
          ) : null}
          {showDetails && details ? (
            <AppText variant="label" tone="muted" selectable>
              {details}
            </AppText>
          ) : null}
          {signature && (step === 'confirming' || showDetails) ? (
            <Button
              variant="text"
              label="View the transaction in the explorer"
              onPress={() => void openURL(getExplorerUrl(`tx/${signature}`))}
            />
          ) : null}
          <View className="grow" />
          {step === 'confirming' && !error ? (
            <ActivityIndicator testID="onboarding-waiting" accessibilityLabel="Waiting for Solana" color={primary} />
          ) : (
            <Button
              testID="onboarding-next"
              variant="filled"
              label={content.action}
              busy={busy}
              onPress={() => void next()}
            />
          )}
        </View>
      ) : (
        <ActivityIndicator testID="onboarding-loading" accessibilityLabel="Checking this phone" color={primary} />
      )}
    </Screen>
  )
}
