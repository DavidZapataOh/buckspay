import { formatDateTime, formatMoney, parseAmount } from '../../i18n/format'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { equalBytes } from '@noble/curves/utils.js'
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import { Amount } from '../../components/amount'
import { AmountField } from '../../components/amount-field'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import { Hero } from '../../components/hero'
import { Icon } from '../../components/icon'
import { Info } from '../../components/info'
import { Screen } from '../../components/screen'
import { Stage } from '../../components/stage'
import { StatusNote } from '../../components/status-note'
import { feedback } from '../../feedback'
import { useThemeColors } from '../../theme/use-theme-colors'
import { GRACE } from '../../protocol'

import { BUILD_TOKEN } from '../pay/tokens'
import type { Contact } from './contacts'

import { REMOTE_MIN_WINDOW } from './plan'

const when = (seconds: number) => formatDateTime(seconds, currentLanguage())

/**
 * Pay → Far away: pick a contact, type an amount, read when the payment stops being payable, confirm. The deadline is
 * the last moment a settlement can land; `deadlineFor` gives the planned note's own when the payment was planned.
 */
export function FarAwayPay({
  contacts,
  now,
  online,
  pendingTo = [],
  deadlineFor = () => now + REMOTE_MIN_WINDOW + GRACE,
  busy = false,
  error,
  onConfirm,
  onAddLink,
  tip,
}: {
  contacts: readonly Contact[]
  now: number
  online: boolean
  /** Wallets with a remote payment that has not ended. */
  pendingTo?: readonly Uint8Array[]
  deadlineFor?: (contact: Contact, amount: bigint) => number
  busy?: boolean
  error?: string
  onConfirm?: (contact: Contact, amount: bigint) => void
  onAddLink?: () => void
  /** The tip paid to the phone that hands this payment in, shown when tipping is on. */
  tip?: { value: bigint }
}) {
  const { t } = useTranslation(NAMESPACES)
  const [onContainer] = useThemeColors('on-secondary-container')

  const [chosen, setChosen] = useState<Contact>()
  const [typed, setTyped] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const amount = parseAmount(typed, BUILD_TOKEN.decimals)
  const payable = chosen !== undefined && chosen.check !== 'no-account' && amount !== undefined && amount > 0n
  const pending = chosen !== undefined && pendingTo.some((wallet) => equalBytes(wallet, chosen.wallet))
  const step = reviewing ? 2 : chosen ? 1 : 0

  return (
    <Screen testID="far-away-pay" steps={{ total: 3, current: step }}>
      {!chosen ? (
        <>
          {contacts.length === 0 ? (
            <Stage hero={<Hero kind="wallet" decorative />} title={t('remote:noContacts')} />
          ) : (
            <AppText variant="headline" className="text-center">
              {t('remote:pickContact')}
            </AppText>
          )}
          <View className="gap-3">
            {contacts.map((contact) => (
              <Pressable
                key={bytesKey(contact.wallet)}
                accessibilityRole="button"
                accessibilityLabel={contact.name}
                onPress={() => {
                  feedback.cue('tap')
                  setChosen(contact)
                  setReviewing(false)
                }}
                className="min-h-16 flex-row items-center gap-3 rounded-3xl border border-outline bg-surface p-4 active:bg-secondary-container"
              >
                <View className="size-12 items-center justify-center rounded-full bg-secondary-container">
                  <Icon name="person" color={onContainer} />
                </View>
                <AppText variant="title">{contact.name}</AppText>
              </Pressable>
            ))}
          </View>
          {onAddLink ? <Button variant="tonal" label={t('remote:addLink')} onPress={onAddLink} /> : null}
        </>
      ) : null}
      {chosen && !reviewing ? (
        <View className="gap-3">
          <View className="flex-row items-center justify-center gap-2">
            <Chip center kind="info" icon="person" label={chosen.name} />
            <Button variant="text" label={t('remote:edit')} onPress={() => setChosen(undefined)} />
          </View>
          {chosen.check === 'not-checked' ? <Chip center kind="waiting" label={t('remote:notChecked')} /> : null}
          {chosen.check === 'no-account' ? <Chip center kind="problem" label={t('remote:noAccount')} /> : null}
          {pending ? <Chip center kind="waiting" label={t('remote:pendingWarning')} /> : null}
          <AmountField label={t('remote:amount')} symbol={BUILD_TOKEN.symbol} value={typed} onChangeText={setTyped} />
          <Button variant="filled" label={t('remote:review')} disabled={!payable} onPress={() => setReviewing(true)} />
        </View>
      ) : null}
      {chosen && reviewing && amount !== undefined ? (
        <View className="gap-4">
          <Stage hero={<Hero kind="wallet" decorative size={120} />} title={chosen.name}>
            <Amount value={formatMoney(amount, BUILD_TOKEN.decimals, currentLanguage())} symbol={BUILD_TOKEN.symbol} />
            <View className="flex-row items-center gap-1">
              <Chip center kind="info" icon="event" label={when(deadlineFor(chosen, amount))} />
              <Info
                title={t('remote:confirm')}
                lines={[
                  t('remote:reviewLine', {
                    name: chosen.name,
                    amount: formatMoney(amount, BUILD_TOKEN.decimals, currentLanguage()),
                    symbol: BUILD_TOKEN.symbol,
                    deadline: when(deadlineFor(chosen, amount)),
                  }),
                  online ? t('remote:onlineNote') : t('remote:offlineNote'),
                  t('remote:privacy'),
                ]}
              />
            </View>
            {tip ? (
              <View testID="delivery-tip">
                <Chip
                  center
                  kind="info"
                  icon="redeem"
                  label={t('rewards:tipReview', {
                    amount: formatMoney(tip.value, BUILD_TOKEN.decimals, currentLanguage()),
                    symbol: BUILD_TOKEN.symbol,
                  })}
                />
              </View>
            ) : null}
          </Stage>
          <StatusNote tone="danger" message={error} />
          <Button
            variant="filled"
            label={t('remote:confirm')}
            busy={busy}
            onPress={() => onConfirm?.(chosen, amount)}
          />
          <Button variant="text" label={t('remote:edit')} onPress={() => setReviewing(false)} />
        </View>
      ) : null}
    </Screen>
  )
}

const bytesKey = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
