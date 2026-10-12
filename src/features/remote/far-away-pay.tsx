import { formatDateTime, formatMoney, parseAmount } from '../../i18n/format'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { equalBytes } from '@noble/curves/utils.js'
import { useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { StatusNote } from '../../components/status-note'
import { TextField } from '../../components/text-field'
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

  const [chosen, setChosen] = useState<Contact>()
  const [typed, setTyped] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const amount = parseAmount(typed, BUILD_TOKEN.decimals)
  const payable = chosen !== undefined && chosen.check !== 'no-account' && amount !== undefined && amount > 0n
  const pending = chosen !== undefined && pendingTo.some((wallet) => equalBytes(wallet, chosen.wallet))

  return (
    <Screen testID="far-away-pay">
      <AppText variant="headline">{t('remote:title')}</AppText>
      {contacts.length === 0 ? <AppText variant="body">{t('remote:noContacts')}</AppText> : null}
      <View className="gap-2">
        {contacts.map((contact) => (
          <Button
            key={bytesKey(contact.wallet)}
            variant={chosen === contact ? 'filled' : 'tonal'}
            label={contact.name}
            onPress={() => {
              setChosen(contact)
              setReviewing(false)
            }}
          />
        ))}
        {onAddLink ? <Button variant="text" label={t('remote:addLink')} onPress={onAddLink} /> : null}
      </View>
      {chosen && !reviewing ? (
        <View className="gap-3">
          {chosen.check === 'not-checked' ? <AppText variant="body">{t('remote:notChecked')}</AppText> : null}
          {chosen.check === 'no-account' ? <AppText variant="body">{t('remote:noAccount')}</AppText> : null}
          {pending ? <AppText variant="body">{t('remote:pendingWarning')}</AppText> : null}
          <TextField label={t('remote:amount')} value={typed} onChangeText={setTyped} keyboardType="decimal-pad" />
          <Button variant="filled" label={t('remote:review')} disabled={!payable} onPress={() => setReviewing(true)} />
        </View>
      ) : null}
      {chosen && reviewing && amount !== undefined ? (
        <View className="gap-3">
          <AppText variant="body">
            {t('remote:reviewLine', {
              name: chosen.name,
              amount: formatMoney(amount, BUILD_TOKEN.decimals, currentLanguage()),
              symbol: BUILD_TOKEN.symbol,
              deadline: when(deadlineFor(chosen, amount)),
            })}
          </AppText>
          {tip ? (
            <AppText testID="delivery-tip" variant="body">
              {t('rewards:tipReview', {
                amount: formatMoney(tip.value, BUILD_TOKEN.decimals, currentLanguage()),
                symbol: BUILD_TOKEN.symbol,
              })}
            </AppText>
          ) : null}
          <AppText variant="label" tone="muted">
            {online ? t('remote:onlineNote') : t('remote:offlineNote')}
          </AppText>
          <AppText variant="label" tone="muted">
            {t('remote:privacy')}
          </AppText>
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
