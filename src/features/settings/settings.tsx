import { BUCKSPAY_PROGRAM_ADDRESS } from '@project/anchor'
import Constants from 'expo-constants'
import { useState } from 'react'
import { AddressRow } from '../../components/address-row'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { ListRow } from '../../components/list-row'
import { Screen } from '../../components/screen'
import { StatusNote } from '../../components/status-note'
import { keyProtection, SOFTWARE_KEY_WARNING } from '../identity/identity-copy'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { BUILD_NETWORK } from '../network/build-network'

export function Settings() {
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
