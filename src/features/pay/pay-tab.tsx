import { formatMoney } from '../../i18n/format'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { type ReactNode, useState } from 'react'
import { Switch, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'

import type { StoredEvent } from '../event/store'

import type { UnfinishedView } from './unfinished'

/** The Pay tab: what can be paid without internet, the way to scan a request, and what was left unfinished. */
export function PayTab({
  ready,
  allowance,
  symbol,
  decimals,
  unfinished,
  credit,
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
    <Screen testID="pay">
      <AppText variant="headline">{t('payment:pay.title')}</AppText>
      {ready ? how : null}
      {!ready ? (
        <View className="gap-4">
          <AppText variant="body">{t('payment:pay.setup')}</AppText>
          <Button testID="setup-payments" variant="filled" label={t('payment:pay.setupAction')} onPress={onSetup} />
        </View>
      ) : (
        <>
          <View className="gap-3">
            {allowance > 0n ? (
              <AppText testID="pay-allowance" variant="body">
                {t('payment:pay.allowance', { amount: formatMoney(allowance, decimals, currentLanguage()), symbol })}
              </AppText>
            ) : (
              <>
                <AppText testID="pay-allowance" variant="body">
                  {t('payment:pay.noAllowance')}
                </AppText>
                <Button testID="add-money" variant="tonal" label={t('payment:pay.addMoney')} onPress={onAddMoney} />
              </>
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
          <View className="gap-3">
            <Button testID="pay-scan" variant="filled" label={t('payment:pay.scan')} onPress={onScan} />
            <Button testID="pay-paste" variant="text" label={t('payment:pay.paste')} onPress={onPaste} />
            {onFarAway ? (
              <Button testID="pay-far-away" variant="tonal" label={t('remote:title')} onPress={onFarAway} />
            ) : null}
          </View>
          {unfinished.length > 0 ? (
            <View testID="pay-unfinished" className="gap-3">
              {unfinished.map((row) => {
                const id = Array.from(row.messageId, (b) => b.toString(16).padStart(2, '0')).join('')
                return (
                  <View key={id} className="gap-3 rounded-3xl bg-surface p-5">
                    <AppText variant="body">
                      {t('payment:pay.unfinished', {
                        amount: formatMoney(row.amount, decimals, currentLanguage()),
                        symbol,
                        code: row.code,
                      })}
                    </AppText>
                    {row.signed ? (
                      <AppText variant="body" tone="muted">
                        {t('payment:pay.notConfirmed')}
                      </AppText>
                    ) : null}
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
