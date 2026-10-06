import { equalBytes } from '@noble/curves/utils.js'
import { useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { StatusNote } from '../../components/status-note'
import { TextField } from '../../components/text-field'
import { GRACE } from '../../protocol'
import { formatMoney, parseAmount } from '../../utils/format-amount'
import { text } from '../payment/copy'
import { BUILD_TOKEN } from '../pay/tokens'
import type { Contact } from './contacts'
import { remoteCopy } from './copy'
import { REMOTE_MIN_WINDOW } from './plan'

const when = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

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
}) {
  const [chosen, setChosen] = useState<Contact>()
  const [typed, setTyped] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const amount = parseAmount(typed, BUILD_TOKEN.decimals)
  const payable = chosen !== undefined && chosen.check !== 'no-account' && amount !== undefined && amount > 0n
  const pending = chosen !== undefined && pendingTo.some((wallet) => equalBytes(wallet, chosen.wallet))

  return (
    <Screen testID="far-away-pay">
      <AppText variant="headline">{remoteCopy.title}</AppText>
      {contacts.length === 0 ? <AppText variant="body">{remoteCopy.noContacts}</AppText> : null}
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
        {onAddLink ? <Button variant="text" label={remoteCopy.addLink} onPress={onAddLink} /> : null}
      </View>
      {chosen && !reviewing ? (
        <View className="gap-3">
          {chosen.check === 'not-checked' ? <AppText variant="body">{remoteCopy.notChecked}</AppText> : null}
          {chosen.check === 'no-account' ? <AppText variant="body">{remoteCopy.noAccount}</AppText> : null}
          {pending ? <AppText variant="body">{remoteCopy.pendingWarning}</AppText> : null}
          <TextField label={remoteCopy.amount} value={typed} onChangeText={setTyped} keyboardType="decimal-pad" />
          <Button variant="filled" label={remoteCopy.review} disabled={!payable} onPress={() => setReviewing(true)} />
        </View>
      ) : null}
      {chosen && reviewing && amount !== undefined ? (
        <View className="gap-3">
          <AppText variant="body">
            {text(remoteCopy.reviewLine, {
              name: chosen.name,
              amount: formatMoney(amount, BUILD_TOKEN.decimals),
              symbol: BUILD_TOKEN.symbol,
              deadline: when(deadlineFor(chosen, amount)),
            })}
          </AppText>
          <AppText variant="label" tone="muted">
            {online ? remoteCopy.onlineNote : remoteCopy.offlineNote}
          </AppText>
          <AppText variant="label" tone="muted">
            {remoteCopy.privacy}
          </AppText>
          <StatusNote tone="danger" message={error} />
          <Button variant="filled" label={remoteCopy.confirm} busy={busy} onPress={() => onConfirm?.(chosen, amount)} />
          <Button variant="text" label={remoteCopy.edit} onPress={() => setReviewing(false)} />
        </View>
      ) : null}
    </Screen>
  )
}

const bytesKey = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
