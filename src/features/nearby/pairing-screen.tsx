import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import { Hero } from '../../components/hero'
import { Info } from '../../components/info'
import { Screen } from '../../components/screen'
import { Stage } from '../../components/stage'
import { Tile } from '../../components/tile'
import { feedback } from '../../feedback'
import { useSecondsLeft } from '../receive/use-seconds-left'
import { QrPresenter } from '../qr/qr-presenter'
import { failureText, spokenDigits } from './copy'
import { abandonPairing, completePairing, friendCodeShown, type PairingRole } from './handoff'
import { usePairing } from './use-pairing'

const SEARCH_GRACE_MS = 10_000

/** The pairing of one role: permission and Bluetooth first, then the code or the list, then both people compare the digits. */
export function PairingScreen({ role }: { role: PairingRole }) {
  const { t } = useTranslation(NAMESPACES)

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
  const asked = confirming !== undefined
  useEffect(() => {
    if (asked) feedback.cue('step')
  }, [asked])

  return (
    <Screen testID="nearby-pairing">
      {status.name === 'blocked' && status.reason === 'disabled' ? (
        <>
          <Stage hero={<Hero kind="problem" decorative />} title={t('nearby:bluetoothOff')} />
          <Button variant="filled" label={t('nearby:openBluetooth')} onPress={pairing.openBluetoothSettings} />
          <Button variant="text" label={t('nearby:tryAgain')} onPress={pairing.restart} />
        </>
      ) : null}
      {status.name === 'blocked' && status.reason === 'permission-denied' ? (
        <>
          <Stage hero={<Hero kind="problem" decorative />} title={t('nearby:needsPermission')}>
            <Info title={t('nearby:needsPermission')} lines={[t('nearby:needsLocation')]} />
          </Stage>
          <Button variant="filled" label={t('nearby:allow')} onPress={() => void pairing.allow()} />
        </>
      ) : null}
      {status.name === 'blocked' && (status.reason === 'unsupported' || status.reason === 'hardware-missing') ? (
        <Stage hero={<Hero kind="problem" decorative />} title={t('nearby:unsupported')} />
      ) : null}
      {status.name === 'running' && !confirming && role === 'receiver' ? (
        <>
          <Stage hero={<Hero kind="nearby" decorative />} title={t('nearby:hostTitle')} line={t('nearby:hostHint')}>
            <View
              accessible
              accessibilityLabel={[...(pairing.tag ?? '')].join(' ')}
              className="rounded-3xl border border-outline bg-surface px-8 py-5"
            >
              <Text className="text-6xl leading-[68px] font-bold tracking-widest text-strong">{pairing.tag}</Text>
            </View>
          </Stage>
          {friendCodeShown() ? (
            <View className="items-center gap-3">
              <QrPresenter texts={[friendCodeShown()!]} accessibilityLabel={t('debts:showCode')} />
              <AppText variant="body" tone="muted">
                {t('debts:showCode')}
              </AppText>
            </View>
          ) : null}
        </>
      ) : null}
      {status.name === 'running' && !confirming && role === 'payer' ? (
        <>
          <Stage hero={<Hero kind="nearby" decorative />} title={t('nearby:searching')} />
          <View className="gap-3">
            {pairing.peers.map((peer) => (
              <Tile
                key={peer.endpointId}
                icon="smartphone"
                title={peer.tag}
                onPress={() => pairing.pick(peer.endpointId)}
              />
            ))}
          </View>
          {searchedLong && pairing.peers.length === 0 ? (
            <View className="flex-row items-center justify-center gap-1">
              <Chip center kind="waiting" label={t('nearby:nobodyYet')} />
              <Info title={t('nearby:nobodyYet')} lines={[t('nearby:noneFound')]} />
            </View>
          ) : null}
        </>
      ) : null}
      {status.name === 'running' && confirming ? (
        <View className="items-center gap-4">
          <Stage hero={<Hero kind="nearby" decorative size={120} />} title={t('nearby:confirmTitle')}>
            <View
              accessible
              accessibilityLabel={t('nearby:confirm', { digits: spokenDigits(confirming.digits) })}
              className="rounded-3xl border border-outline bg-surface px-8 py-5"
            >
              <Text className="text-6xl leading-[68px] font-bold tracking-widest text-strong">{confirming.digits}</Text>
            </View>
            <Chip center kind="waiting" label={t('nearby:secondsLeft', { seconds: left })} />
          </Stage>
          <View className="w-full gap-3">
            <Button variant="filled" label={t('nearby:match')} onPress={pairing.confirm} />
            <Button variant="tonal" label={t('nearby:mismatch')} onPress={pairing.decline} />
          </View>
        </View>
      ) : null}
      {status.name === 'failed' ? (
        <>
          <Stage hero={<Hero kind="problem" decorative />} title={failureText(status.reason) ?? t('nearby:tryAgain')} />
          <Button variant="filled" label={t('nearby:tryAgain')} onPress={pairing.restart} />
        </>
      ) : null}
      {confirming ? null : <Button variant="text" label={t('payment:review.cancel')} onPress={() => router.back()} />}
    </Screen>
  )
}
