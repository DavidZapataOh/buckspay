import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Switch, View } from 'react-native'
import { AmountField } from '../../components/amount-field'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import { Info } from '../../components/info'
import { StatusNote } from '../../components/status-note'
import { TextField } from '../../components/text-field'
import { NAMESPACES } from '../../i18n'

export type ReceiveFormProps = {
  amount: string
  onAmountChange: (value: string) => void
  memo: string
  onMemoChange: (value: string) => void
  passOn: boolean
  onPassOnChange: (value: boolean) => void
  /** The amount written is one the app accepts. */
  amountValid: boolean
  /** The amount is valid but smaller than the smallest payment the server credits at once. */
  belowMinimum: boolean
  error?: string
  onShow: () => void
  /** The smallest payment credited at once, already formatted; undefined while it is unknown. */
  minimumText: string | undefined
  symbol: string
  /** The most one payment can be, already formatted. */
  maxText: string
  /** How long a payment has to stay valid, already formatted. */
  windowText: string
}

/** The request a person makes to be paid: the amount, big, and the rest only when they reach for it. */
export function ReceiveForm({
  amount,
  onAmountChange,
  memo,
  onMemoChange,
  passOn,
  onPassOnChange,
  amountValid,
  belowMinimum,
  error,
  onShow,
  minimumText,
  symbol,
  maxText,
  windowText,
}: ReceiveFormProps) {
  const { t } = useTranslation(NAMESPACES)
  const [noting, setNoting] = useState(memo !== '')
  const typedWrong = !amountValid && amount.trim() !== ''
  const help = [
    t('payment:receive.passOnHelp'),
    t('payment:receive.limits', { max: maxText, window: windowText }),
    t('payment:receive.bondLimit'),
    ...(minimumText !== undefined ? [t('payment:receive.minimum', { amount: minimumText })] : []),
  ]
  return (
    <>
      <AmountField
        testID="receive-amount"
        label={t('payment:receive.amount')}
        symbol={symbol}
        value={amount}
        onChangeText={onAmountChange}
      />
      {typedWrong || belowMinimum ? (
        <View className="items-center gap-2">
          {typedWrong ? (
            <Chip
              center
              testID="receive-needs-amount"
              kind="problem"
              label={t('payment:receive.amountUnclear', { max: maxText })}
            />
          ) : null}
          {belowMinimum ? (
            <Chip center testID="receive-below-minimum" kind="waiting" label={t('payment:receive.belowMinimum')} />
          ) : null}
        </View>
      ) : null}
      {noting ? (
        <TextField testID="receive-memo" label={t('payment:receive.memo')} value={memo} onChangeText={onMemoChange} />
      ) : (
        <Button
          testID="receive-add-note"
          variant="text"
          label={t('payment:receive.addNote')}
          onPress={() => setNoting(true)}
        />
      )}
      <View className="min-h-14 flex-row items-center justify-between gap-2">
        <View className="flex-1">
          <AppText variant="body">{t('payment:receive.passOn')}</AppText>
        </View>
        <Switch
          testID="receive-pass-on"
          accessibilityLabel={t('payment:receive.passOn')}
          value={passOn}
          onValueChange={onPassOnChange}
        />
        <Info title={t('payment:receive.passOn')} lines={help} />
      </View>
      <StatusNote tone="danger" message={error} />
      <Button
        testID="receive-create"
        variant="filled"
        label={t('payment:receive.create')}
        disabled={!amountValid}
        onPress={onShow}
      />
    </>
  )
}
