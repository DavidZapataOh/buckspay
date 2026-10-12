import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { openURL } from 'expo-linking'
import { router } from 'expo-router'
import { useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { AddressRow } from '../../components/address-row'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Hero, type HeroKind } from '../../components/hero'
import { IconButton } from '../../components/icon-button'
import { Info } from '../../components/info'
import { Screen } from '../../components/screen'
import { Stage } from '../../components/stage'
import { StatusNote } from '../../components/status-note'
import { useThemeColors } from '../../theme/use-theme-colors'
import { useNetwork } from '../network/use-network'
import { ACTIVE_PROFILE } from '../../protocol/active-profile'
import { useFaucet } from '../lock/use-faucet'
import { ActivationForm } from './activation-form'
import { confirmingNotice, keyProtection, sponsorshipNotice, stepCopy } from './identity-copy'
import { useDeviceIdentity } from './use-device-identity'

const STAGE = { connect: 0, 'create-key': 1, activate: 2, confirming: 3 } as const
const HEROES: Record<string, HeroKind> = {
  loading: 'waiting',
  unreachable: 'problem',
  connect: 'wallet',
  'create-key': 'key',
  activate: 'coins',
  confirming: 'waiting',
  'other-wallet': 'problem',
}

/** Sets up paying and receiving: a wallet, this phone's key and its first lock. */
export function Onboarding() {
  const { t } = useTranslation(NAMESPACES)

  const { getExplorerUrl } = useNetwork()
  const { step, busy, error, details, signature, activation, sponsorship, wallet, device, deviceKey, next } =
    useDeviceIdentity()
  const [showDetails, setShowDetails] = useState(false)
  const faucet = useFaucet(wallet)
  const [primary] = useThemeColors('primary')
  // While loading, the screen shows a spinner, or a retry once the derivation failed.
  const content = step === 'ready' || (step === 'loading' && !error) ? undefined : stepCopy(step)
  const notice =
    step === 'confirming'
      ? confirmingNotice(signature)
      : step === 'activate' && !error
        ? sponsorshipNotice(sponsorship)
        : undefined

  return (
    <Screen steps={step in STAGE ? { total: 3, current: STAGE[step as keyof typeof STAGE] } : undefined}>
      <View className="flex-row items-center justify-between -ml-3">
        <IconButton testID="onboarding-close" icon="close" label={t('common:close')} onPress={() => router.back()} />
      </View>
      {content ? (
        <View testID={`onboarding-${step}`} className="grow gap-4">
          <Stage hero={<Hero kind={HEROES[step] ?? 'waiting'} decorative />} title={content.title} line={content.line}>
            <Info title={content.title} lines={[content.body]} />
          </Stage>
          {step === 'activate' && activation ? (
            <ActivationForm
              activation={activation}
              sponsorship={sponsorship}
              windows={ACTIVE_PROFILE.windows}
              busy={busy}
              action={content.action}
              faucet={faucet}
              onSubmit={(input) => void next(input)}
            />
          ) : null}
          {step === 'other-wallet' && device ? (
            <AddressRow testID="registered-wallet" address={device.wallet} label={t('common:registeredTo')} />
          ) : null}
          {wallet ? (
            <View className="gap-1">
              <AppText variant="label" tone="muted">
                {t('common:connectedWallet')}
              </AppText>
              <AppText testID="wallet-address" variant="label" selectable>
                {wallet}
              </AppText>
            </View>
          ) : null}
          {deviceKey ? (
            <AppText testID="security-level" variant="label" tone="muted">
              {t('identity:keyProtectionLine', { value: keyProtection(deviceKey.securityLevel) })}
            </AppText>
          ) : null}
          <StatusNote testID="onboarding-notice" tone="default" message={notice} />
          <StatusNote testID="onboarding-error" tone="danger" message={error} />
          {details ? (
            <Button
              testID="onboarding-details"
              variant="text"
              label={showDetails ? t('common:hideDetails') : t('common:details')}
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
              label={t('identity:viewTransaction')}
              onPress={() => void openURL(getExplorerUrl(`tx/${signature}`))}
            />
          ) : null}
          <View className="grow" />
          {step === 'confirming' && !error ? (
            <ActivityIndicator
              testID="onboarding-waiting"
              accessibilityLabel={t('identity:waitingForSolana')}
              color={primary}
            />
          ) : step === 'activate' && activation ? null : (
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
        <ActivityIndicator testID="onboarding-loading" accessibilityLabel={t('common:checkingPhone')} color={primary} />
      )}
    </Screen>
  )
}
