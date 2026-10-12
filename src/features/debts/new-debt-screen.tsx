import { parseAmount } from '../../i18n/format'
import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { useState } from 'react'
import { View } from 'react-native'
import { AmountField } from '../../components/amount-field'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import { Info } from '../../components/info'
import { Screen } from '../../components/screen'
import { Segmented } from '../../components/segmented'
import { StatusNote } from '../../components/status-note'
import { TextField } from '../../components/text-field'

import { MAX_MEMO_BYTES, type TabIntent } from './tab'

const DAY = 24 * 60 * 60
/** The due dates on offer; a longer one would never join a netting. */
const DUE_CHOICES = [
  { key: 'onDemand', days: 0 },
  { key: 'week', days: 7 },
  { key: 'month', days: 30 },
  { key: 'quarter', days: 90 },
] as const

/** Asks what was lent or borrowed, for what and until when, and hands the intent to `onSubmit`. */
export function NewDebtScreen({
  symbol,
  decimals,
  peerLabel,
  viaCode,
  busy,
  error,
  onSubmit,
}: {
  symbol: string
  decimals: number
  /** The friend, when the code or the connection says who it is. */
  peerLabel: string | null
  /** The offer travels as a code on a screen, which anyone nearby can read. */
  viaCode: boolean
  busy: boolean
  error: string | null
  onSubmit: (intent: Pick<TabIntent, 'kind' | 'amount' | 'due' | 'memo'>) => void
}) {
  const { t } = useTranslation(NAMESPACES)

  const [kind, setKind] = useState<'lent' | 'borrowed'>('lent')
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [noting, setNoting] = useState(false)
  const [due, setDue] = useState<(typeof DUE_CHOICES)[number]['key']>('onDemand')
  const [problem, setProblem] = useState<string>()

  function submit() {
    const units = parseAmount(amount, decimals)
    if (units === undefined || units === 0n) return setProblem(t('debts:errors.amount'))
    if (new TextEncoder().encode(memo).length > MAX_MEMO_BYTES) return setProblem(t('debts:errors.memo'))
    setProblem(undefined)
    const days = DUE_CHOICES.find((choice) => choice.key === due)?.days ?? 0
    onSubmit({
      kind,
      amount: units,
      due: days === 0 ? 0 : Math.floor(Date.now() / 1000) + days * DAY,
      memo: memo === '' ? null : memo,
    })
  }

  return (
    <Screen testID="new-debt" footer={<Button variant="filled" label={t('debts:send')} busy={busy} onPress={submit} />}>
      <View className="flex-row items-center justify-between">
        <AppText variant="headline">{peerLabel ?? t('debts:newDebt')}</AppText>
        {viaCode ? <Info title={t('debts:newDebt')} lines={[t('debts:viaCode')]} /> : null}
      </View>
      <Segmented
        value={kind}
        onChange={setKind}
        options={[
          { id: 'lent', label: t('debts:lent'), icon: 'north_east' },
          { id: 'borrowed', label: t('debts:borrowed'), icon: 'south_west' },
        ]}
      />
      <AmountField label={t('debts:amount')} symbol={symbol} value={amount} onChangeText={setAmount} />
      {noting ? (
        <TextField label={t('debts:memo')} value={memo} onChangeText={setMemo} />
      ) : (
        <Button variant="text" label={t('debts:addNote')} onPress={() => setNoting(true)} />
      )}
      <Segmented
        value={due}
        onChange={setDue}
        options={DUE_CHOICES.map((choice) => ({ id: choice.key, label: t(`debts:due.${choice.key}`) }))}
      />
      {viaCode ? <Chip center kind="waiting" label={t('debts:viaCodeShort')} /> : null}
      <StatusNote tone="danger" message={problem ?? error ?? undefined} />
    </Screen>
  )
}
