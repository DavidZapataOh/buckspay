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
import { MeshSettings, type MeshSettingsProps } from '../mesh/mesh-settings'
import { keyProtection, SOFTWARE_KEY_WARNING } from '../identity/identity-copy'
import { eventCopy } from '../event/copy'
import { copy, text } from '../payment/copy'
import { MIN_TIP_BOND, rewardsCopy } from '../rewards/copy'
import { formatMoney } from '../../utils/format-amount'
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
      <AppText variant="headline">Settings</AppText>
      <ListRow testID="network" title="Network" value={BUILD_NETWORK.label} />
      {wallet ? (
        <AddressRow testID="wallet" address={wallet} label="Connected wallet" />
      ) : (
        <ListRow testID="wallet" title="Connected wallet" value={checking ? 'Checking…' : 'Not connected'} />
      )}
      {device ? (
        <AddressRow testID="registered-to" address={device.wallet} label="Registered to" />
      ) : (
        <ListRow testID="registered-to" title="Registered to" value={checking ? 'Checking…' : 'Not registered'} />
      )}
      <ListRow
        testID="security-level"
        title="Key protection"
        value={checking ? 'Checking…' : deviceKey ? keyProtection[deviceKey.securityLevel] : 'No key on this phone'}
      />
      {deviceKey?.securityLevel === 'software' ? <StatusNote tone="danger" message={SOFTWARE_KEY_WARNING} /> : null}
      <StatusNote tone="danger" message={error} />
      {wallet ? (
        <Button
          testID="disconnect"
          variant="tonal"
          label="Forget wallet on this phone"
          busy={forgetting}
          disabled={busy}
          onPress={() => void forget()}
        />
      ) : null}
      {payments ? (
        <>
          <AppText variant="title" accessibilityRole="header" className="mt-4">
            {copy.settings.limits}
          </AppText>
          <Button testID="events" variant="tonal" label={eventCopy.settings} onPress={payments.onEvents} />
          <ListRow testID="limit-per-payment" title={copy.settings.perPayment} value={payments.limits.perPayment} />
          <ListRow testID="limit-biometric" title={copy.settings.biometricFrom} value={payments.limits.biometricFrom} />
          <ListRow
            testID="limit-biometric-daily"
            title={copy.settings.biometricDaily}
            value={payments.limits.biometricDaily}
          />
          <ListRow testID="limit-window" title={copy.settings.window} value={payments.limits.window} />
          <NearbyCheckSettings {...payments.nearbyCheck} />
          <ListRow
            testID="uninstall"
            title={copy.settings.uninstall}
            value={text(copy.settings.uninstallBody, { count: payments.unsettled })}
          />
          <Button
            testID="reset-identity"
            variant="tonal"
            label={copy.settings.reset}
            disabled={busy}
            onPress={payments.onReset}
          />
        </>
      ) : null}
      {mesh ? <MeshSettings {...mesh} /> : null}
      {privateData ? <PrivateDataRow {...privateData} /> : null}
      {tipping ? <TipRow {...tipping} /> : null}
      <AppText variant="title" accessibilityRole="header" className="mt-4">
        Technical details
      </AppText>
      {device ? <AddressRow address={device.address} label="Device account" /> : null}

      {deviceKey ? (
        <ListRow title="Key attestation" value={`Chain of ${deviceKey.attestationChain.length} certificates`} />
      ) : null}
      <AddressRow address={BUCKSPAY_PROGRAM_ADDRESS} label="Program" />
      <ListRow title="Version" value={Constants.expoConfig?.version ?? 'Unknown'} />
    </Screen>
  )
}

function TipRow({ on, wordValue, bond, symbol, decimals, onToggle }: TippingSettings) {
  const covered = bond >= MIN_TIP_BOND
  return (
    <View testID="tipping" className="gap-1">
      <AppText variant="title" accessibilityRole="header" className="mt-4">
        {rewardsCopy.tipSection}
      </AppText>
      <View className="min-h-14 flex-row items-center justify-between">
        <View className="flex-1 pr-4">
          <AppText variant="body">{rewardsCopy.tipSwitch}</AppText>
          <AppText variant="label" tone="muted">
            {covered
              ? text(rewardsCopy.tipAmount, { amount: formatMoney(wordValue, decimals), symbol })
              : rewardsCopy.tipNeedsBond}
          </AppText>
        </View>
        <Switch
          testID="tip-switch"
          accessibilityLabel={rewardsCopy.tipSwitch}
          value={covered && on}
          disabled={!covered}
          onValueChange={onToggle}
        />
      </View>
    </View>
  )
}
