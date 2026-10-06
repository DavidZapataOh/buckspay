import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { StatusNote } from '../../components/status-note'
import { useSecondsLeft } from '../receive/use-seconds-left'
import { text } from '../payment/copy'
import { failureText, nearbyCopy, spokenDigits } from './copy'
import { abandonPairing, completePairing, type PairingRole } from './handoff'
import { usePairing } from './use-pairing'

const SEARCH_GRACE_MS = 10_000

/** The pairing of one role: permission and Bluetooth first, then the code or the list, then both people compare the digits. */
export function PairingScreen({ role }: { role: PairingRole }) {
  const pairing = usePairing(role, (link) => {
    completePairing(link)
    router.back()
  })
  const { status, confirming } = pairing
  const left = useSecondsLeft(pairing.deadline)
  const [searchedLong, setSearchedLong] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSearchedLong(true), SEARCH_GRACE_MS)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => () => abandonPairing('Declined'), [])

  return (
    <Screen testID="nearby-pairing">
      {status.name === 'blocked' && status.reason === 'disabled' ? (
        <>
          <AppText variant="body">{nearbyCopy.bluetoothOff}</AppText>
          <Button variant="filled" label={nearbyCopy.openBluetooth} onPress={pairing.openBluetoothSettings} />
          <Button variant="text" label={nearbyCopy.tryAgain} onPress={pairing.restart} />
        </>
      ) : null}
      {status.name === 'blocked' && status.reason === 'permission-denied' ? (
        <>
          <AppText variant="body">{nearbyCopy.needsPermission}</AppText>
          <AppText variant="label" tone="muted">
            {nearbyCopy.needsLocation}
          </AppText>
          <Button variant="filled" label={nearbyCopy.allow} onPress={() => void pairing.allow()} />
        </>
      ) : null}
      {status.name === 'blocked' && (status.reason === 'unsupported' || status.reason === 'hardware-missing') ? (
        <AppText variant="body">{nearbyCopy.unsupported}</AppText>
      ) : null}
      {status.name === 'running' && !confirming && role === 'receiver' ? (
        <>
          <AppText variant="title">{nearbyCopy.hostTitle}</AppText>
          <AppText variant="display" accessibilityLabel={[...(pairing.tag ?? '')].join(' ')}>
            {pairing.tag}
          </AppText>
          <AppText variant="body" tone="muted">
            {nearbyCopy.hostHint}
          </AppText>
        </>
      ) : null}
      {status.name === 'running' && !confirming && role === 'payer' ? (
        <>
          <AppText variant="body">{nearbyCopy.searching}</AppText>
          {pairing.peers.map((peer) => (
            <Button
              key={peer.endpointId}
              variant="tonal"
              label={peer.tag}
              onPress={() => pairing.pick(peer.endpointId)}
            />
          ))}
          {searchedLong && pairing.peers.length === 0 ? <AppText variant="body">{nearbyCopy.noneFound}</AppText> : null}
        </>
      ) : null}
      {status.name === 'running' && confirming ? (
        <View className="gap-4">
          <AppText
            variant="headline"
            accessibilityLabel={text(nearbyCopy.confirm, { digits: spokenDigits(confirming.digits) })}
          >
            {text(nearbyCopy.confirm, { digits: confirming.digits })}
          </AppText>
          <Button variant="filled" label={nearbyCopy.match} onPress={pairing.confirm} />
          <Button variant="tonal" label={nearbyCopy.mismatch} onPress={pairing.decline} />
          <StatusNote tone="muted" message={text(nearbyCopy.secondsLeft, { seconds: left })} />
        </View>
      ) : null}
      {status.name === 'failed' ? (
        <>
          <StatusNote tone="danger" message={failureText(status.reason)} />
          <Button variant="filled" label={nearbyCopy.tryAgain} onPress={pairing.restart} />
        </>
      ) : null}
    </Screen>
  )
}
