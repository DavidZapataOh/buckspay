import { formatMoney } from '../../i18n/format'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { type ReactNode, useState } from 'react'
import { Switch, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import { Hero } from '../../components/hero'
import { Screen } from '../../components/screen'
import { Tile } from '../../components/tile'
import type { TransportId } from '../../transport/types'

import type { StoredEvent } from '../event/store'

import type { UnfinishedView } from './unfinished'

/** The Pay tab: a picture of how the other phone will be found, what can be paid, and the one way to start. */
export function PayTab({
  ready,
  allowance,
  symbol,
  decimals,
  unfinished,
  credit,
  medium = 'qr',
  onSetup,
  onScan,
  how,
  onPaste,
  onFarAway,
  onAddMoney,
  onResume,
  onDiscard,
}: {
  ready: boolean
  allowance: bigint
  symbol: string
  decimals: number
  unfinished: readonly UnfinishedView[]
  /** The events this phone runs: a switch sells their credit instead of ordinary payments. */
  credit?: {
    events: readonly StoredEvent[]
    selected: StoredEvent | null
    onSelect: (event: StoredEvent | null) => void
  }
  /** How the other phone is reached, which the picture shows. */
  medium?: TransportId
  onSetup: () => void
  onScan: () => void
  /** The control that picks the medium, shown above the actions. */
  how?: ReactNode
  onPaste: () => void
  /** Opens the screen that pays a contact who is not nearby. */
  onFarAway?: () => void
  onAddMoney: () => void
  onResume: (messageId: Uint8Array) => void
  onDiscard: (messageId: Uint8Array) => void
}) {
  const { t } = useTranslation(NAMESPACES)

  const [discarding, setDiscarding] = useState<string>()
  return (
    <Screen testID="pay" steps={{ total: 3, current: 0 }}>
      {ready ? how : null}
      {!ready ? (
        <View className="items-center gap-6 pt-6">
          <Hero kind="scan" decorative />
          <Button testID="setup-payments" variant="filled" label={t('payment:pay.setupAction')} onPress={onSetup} />
        </View>
      ) : (
        <>
          <View className="items-center gap-4 pt-2">
            <Hero kind={medium === 'qr' ? 'scan' : 'nearby'} decorative size={150} />
            {allowance > 0n ? (
              <View testID="pay-allowance">
                <Chip
                  kind="info"
                  icon="wifi_off"
                  label={`${formatMoney(allowance, decimals, currentLanguage())} ${symbol}`}
                />
              </View>
            ) : (
              <View testID="pay-allowance" className="w-full">
                <Tile
                  testID="add-money"
                  highlight
                  icon="add_circle"
                  title={t('payment:pay.addMoney')}
                  onPress={onAddMoney}
                />
              </View>
            )}
          </View>
          {credit?.events.map((event) => (
            <View key={event.name + event.endsAt} className="min-h-14 flex-row items-center justify-between gap-4">
              <View className="flex-1">
                <AppText variant="body">{t('event:creditFor', { event: event.name })}</AppText>
              </View>
              <Switch
                testID="pay-event-credit"
                accessibilityLabel={t('event:creditFor', { event: event.name })}
                value={credit.selected === event}
                onValueChange={(on) => credit.onSelect(on ? event : null)}
              />
            </View>
          ))}
          <View className="gap-2">
            <Button testID="pay-scan" variant="filled" label={t('payment:pay.scan')} onPress={onScan} />
            <View className="flex-row justify-center gap-2">
              <Button testID="pay-paste" variant="text" label={t('payment:pay.paste')} onPress={onPaste} />
              {onFarAway ? (
                <Button testID="pay-far-away" variant="text" label={t('remote:title')} onPress={onFarAway} />
              ) : null}
            </View>
          </View>
          {unfinished.length > 0 ? (
            <View testID="pay-unfinished" className="gap-3">
              {unfinished.map((row) => {
                const id = Array.from(row.messageId, (b) => b.toString(16).padStart(2, '0')).join('')
                return (
                  <View key={id} className="gap-3 rounded-3xl border border-outline bg-surface p-5">
                    <AppText variant="title">
                      {t('payment:pay.unfinished', {
                        amount: formatMoney(row.amount, decimals, currentLanguage()),
                        symbol,
                        code: row.code,
                      })}
                    </AppText>
                    {row.signed ? <Chip kind="waiting" label={t('payment:pay.notConfirmed')} /> : null}
                    {discarding === id ? (
                      <>
                        <AppText variant="body" tone="danger">
                          {t('payment:pay.discardWarning')}
                        </AppText>
                        <Button
                          testID="pay-discard-confirm"
                          variant="tonal"
                          label={t('payment:pay.discard')}
                          onPress={() => {
                            setDiscarding(undefined)
                            onDiscard(row.messageId)
                          }}
                        />
                      </>
                    ) : (
                      <View className="flex-row gap-3">
                        <Button
                          testID="pay-resume"
                          variant="filled"
                          label={row.signed ? t('payment:pay.showAgain') : t('payment:pay.resume')}
                          onPress={() => onResume(row.messageId)}
                        />
                        <Button
                          testID="pay-discard"
                          variant="text"
                          label={t('payment:pay.discard')}
                          onPress={() => setDiscarding(id)}
                        />
                      </View>
                    )}
                  </View>
                )
              })}
            </View>
          ) : null}
        </>
      )}
    </Screen>
  )
}
