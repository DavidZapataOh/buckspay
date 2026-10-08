import { useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { StatusNote } from '../../components/status-note'
import { TextField } from '../../components/text-field'
import { parseAmount } from '../../utils/format-amount'
import { debtsCopy } from './copy'
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
  const [kind, setKind] = useState<'lent' | 'borrowed'>('lent')
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [due, setDue] = useState<(typeof DUE_CHOICES)[number]['key']>('onDemand')
  const [problem, setProblem] = useState<string>()

  function submit() {
    const units = parseAmount(amount, decimals)
    if (units === undefined || units === 0n) return setProblem(debtsCopy.errors.amount)
    if (new TextEncoder().encode(memo).length > MAX_MEMO_BYTES) return setProblem(debtsCopy.errors.memo)
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
    <Screen testID="new-debt">
      <AppText variant="headline">{debtsCopy.newDebt}</AppText>
      {peerLabel ? (
        <AppText variant="label" tone="muted">
          {peerLabel}
        </AppText>
      ) : null}
      <View className="flex-row gap-2">
        <Button variant={kind === 'lent' ? 'filled' : 'tonal'} label={debtsCopy.lent} onPress={() => setKind('lent')} />
        <Button
          variant={kind === 'borrowed' ? 'filled' : 'tonal'}
          label={debtsCopy.borrowed}
          onPress={() => setKind('borrowed')}
        />
      </View>
      <TextField label={debtsCopy.amount} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
      <AppText variant="label" tone="muted">
        {symbol}
      </AppText>
      <TextField label={debtsCopy.memo} value={memo} onChangeText={setMemo} />
      <View className="flex-row flex-wrap gap-2">
        {DUE_CHOICES.map((choice) => (
          <Button
            key={choice.key}
            variant={due === choice.key ? 'filled' : 'tonal'}
            label={debtsCopy.due[choice.key]}
            onPress={() => setDue(choice.key)}
          />
        ))}
      </View>
      {viaCode ? (
        <AppText variant="label" tone="muted">
          {debtsCopy.viaCode}
        </AppText>
      ) : null}
      <StatusNote tone="danger" message={problem ?? error ?? undefined} />
      <Button variant="filled" label={debtsCopy.send} busy={busy} onPress={submit} />
    </Screen>
  )
}
