import { formatMoney } from '../../i18n/format'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { BUCKSPAY_PROGRAM_ADDRESS } from '@project/anchor'
import Constants from 'expo-constants'
import { useState } from 'react'
import { Switch, View } from 'react-native'
import { AddressRow } from '../../components/address-row'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { ListRow } from '../../components/list-row'
import { Screen } from '../../components/screen'
import { StatusNote } from '../../components/status-note'
import { LanguageSetting } from './language-setting'
import { MeshSettings, type MeshSettingsProps } from '../mesh/mesh-settings'
import { keyProtection } from '../identity/identity-copy'

import { MIN_TIP_BOND } from '../rewards/reward-terms'

import { useDeviceIdentity } from '../identity/use-device-identity'
import { BUILD_NETWORK } from '../network/build-network'
import { PrivateDataRow, type PrivateDataProps } from '../zk/private-data-row'
import { NearbyCheckSettings, type NearbyCheckSettingsProps } from '../witness/nearby-check-settings'

export type PaymentsSettings = {
  /** How many received payments have not settled: what an uninstall or a reset would lose. */
  unsettled: number
  limits: { perPayment: string; biometricFrom: string; biometricDaily: string; window: string }
  onReset: () => void
  onEvents: () => void
  nearbyCheck: NearbyCheckSettingsProps
}

export type TippingSettings = {
  on: boolean
  /** What one word pays, from the reward mint. */
  wordValue: bigint
  /** The bond of the lock the tips are made from. */
  bond: bigint
  symbol: string
  decimals: number
  onToggle: (on: boolean) => void
}

export function Settings({
  payments,
  mesh,
  privateData,
  tipping,
}: {
  payments?: PaymentsSettings
  mesh?: MeshSettingsProps
  privateData?: PrivateDataProps
  tipping?: TippingSettings
}) {
  const { t } = useTranslation(NAMESPACES)

  const { step, busy, error, wallet, device, deviceKey, disconnect } = useDeviceIdentity()
  const [forgetting, setForgetting] = useState(false)
  const checking = step === 'loading' && !error

  async function forget() {
    setForgetting(true)
    await disconnect()
    setForgetting(false)
  }

  return (
    <Screen testID="settings">
      <AppText variant="headline">{t('settings:title')}</AppText>
      <LanguageSetting />
      <AppText variant="title" accessibilityRole="header" className="mt-4">
        {t('settings:sections.wallet')}
      </AppText>
      {wallet ? (
        <AddressRow testID="wallet" address={wallet} label={t('common:connectedWallet')} />
      ) : (
        <ListRow
          testID="wallet"
          title={t('common:connectedWallet')}
          value={checking ? t('common:checking') : t('common:notConnected')}
        />
      )}
      {device ? (
        <AddressRow testID="registered-to" address={device.wallet} label={t('common:registeredTo')} />
      ) : (
        <ListRow
          testID="registered-to"
          title={t('common:registeredTo')}
          value={checking ? t('common:checking') : t('common:notRegistered')}
        />
      )}
      <StatusNote tone="danger" message={error} />
      {wallet ? (
        <Button
          testID="disconnect"
          variant="tonal"
          label={t('settings:forgetWallet')}
          busy={forgetting}
          disabled={busy}
          onPress={() => void forget()}
        />
      ) : null}
      {payments ? (
        <>
          <AppText variant="title" accessibilityRole="header" className="mt-4">
            {t('payment:settings.limits')}
          </AppText>
          <ListRow
            testID="limit-per-payment"
            title={t('payment:settings.perPayment')}
            value={payments.limits.perPayment}
          />
          <ListRow
            testID="limit-biometric"
            title={t('payment:settings.biometricFrom')}
            value={payments.limits.biometricFrom}
          />
          <ListRow
            testID="limit-biometric-daily"
            title={t('payment:settings.biometricDaily')}
            value={payments.limits.biometricDaily}
          />
          <ListRow testID="limit-window" title={t('payment:settings.window')} value={payments.limits.window} />
          <ListRow
            testID="uninstall"
            title={t('payment:settings.uninstall')}
            value={t('payment:settings.uninstallBody', { count: payments.unsettled })}
          />
          <Button
            testID="reset-identity"
            variant="tonal"
            label={t('payment:settings.reset')}
            disabled={busy}
            onPress={payments.onReset}
          />
        </>
      ) : null}
      {tipping ? <TipRow {...tipping} /> : null}
      {mesh ? <MeshSettings {...mesh} /> : null}
      <AppText variant="title" accessibilityRole="header" className="mt-4">
        {t('settings:sections.advanced')}
      </AppText>
      <ListRow testID="network" title={t('settings:network')} value={t(`common:network.${BUILD_NETWORK.labelKey}`)} />
      <ListRow
        testID="security-level"
        title={t('settings:keyProtection')}
        value={
          checking ? t('common:checking') : deviceKey ? keyProtection(deviceKey.securityLevel) : t('settings:noKey')
        }
      />
      {deviceKey?.securityLevel === 'software' ? (
        <StatusNote tone="danger" message={t('identity:softwareKeyWarning')} />
      ) : null}
      {payments ? (
        <Button testID="events" variant="tonal" label={t('event:settings')} onPress={payments.onEvents} />
      ) : null}
      {payments ? <NearbyCheckSettings {...payments.nearbyCheck} /> : null}
      {privateData ? <PrivateDataRow {...privateData} /> : null}
      <AppText variant="title" accessibilityRole="header" className="mt-4">
        {t('settings:technicalDetails')}
      </AppText>
      {device ? <AddressRow address={device.address} label={t('settings:deviceAccount')} /> : null}

      {deviceKey ? (
        <ListRow
          title={t('settings:keyAttestation')}
          value={t('settings:certificates', { count: deviceKey.attestationChain.length })}
        />
      ) : null}
      <AddressRow address={BUCKSPAY_PROGRAM_ADDRESS} label={t('settings:program')} />
      <ListRow title={t('settings:version')} value={Constants.expoConfig?.version ?? t('common:unknown')} />
    </Screen>
  )
}

function TipRow({ on, wordValue, bond, symbol, decimals, onToggle }: TippingSettings) {
  const { t } = useTranslation(NAMESPACES)

  const covered = bond >= MIN_TIP_BOND
  return (
    <View testID="tipping" className="gap-1">
      <AppText variant="title" accessibilityRole="header" className="mt-4">
        {t('rewards:tipSection')}
      </AppText>
      <View className="min-h-14 flex-row items-center justify-between">
        <View className="flex-1 pr-4">
          <AppText variant="body">{t('rewards:tipSwitch')}</AppText>
          <AppText variant="label" tone="muted">
            {covered
              ? t('rewards:tipAmount', { amount: formatMoney(wordValue, decimals, currentLanguage()), symbol })
              : t('rewards:tipNeedsBond', {
                  amount: formatMoney(MIN_TIP_BOND, decimals, currentLanguage()) + ' ' + symbol,
                })}
          </AppText>
        </View>
        <Switch
          testID="tip-switch"
          accessibilityLabel={t('rewards:tipSwitch')}
          value={covered && on}
          disabled={!covered}
          onValueChange={onToggle}
        />
      </View>
    </View>
  )
}
