import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Switch, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
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

/** The request a person makes to be paid: what they ask for, and the limits only when they ask to see them. */
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
  const [more, setMore] = useState(false)
  return (
    <>
      <TextField
        testID="receive-amount"
        label={`${t('payment:receive.amount')} (${symbol})`}
        keyboardType="decimal-pad"
        value={amount}
        onChangeText={onAmountChange}
      />
      <TextField testID="receive-memo" label={t('payment:receive.memo')} value={memo} onChangeText={onMemoChange} />
      <View className="min-h-14 flex-row items-center justify-between gap-4">
        <View className="flex-1">
          <AppText variant="body">{t('payment:receive.passOn')}</AppText>
        </View>
        <Switch
          testID="receive-pass-on"
          accessibilityLabel={t('payment:receive.passOn')}
          value={passOn}
          onValueChange={onPassOnChange}
        />
      </View>
      <AppText variant="label" tone="muted">
        {t('payment:receive.passOnHelp')}
      </AppText>
      {belowMinimum ? (
        <AppText testID="receive-below-minimum" variant="label">
          {t('payment:receive.belowMinimum')}
        </AppText>
      ) : null}
      <StatusNote tone="danger" message={error} />
      {amountValid ? null : (
        <AppText testID="receive-needs-amount" variant="label" tone="muted">
          {amount.trim() === ''
            ? t('payment:receive.amountNeeded')
            : t('payment:receive.amountUnclear', { max: maxText })}
        </AppText>
      )}
      <Button
        testID="receive-create"
        variant="filled"
        label={t('payment:receive.create')}
        disabled={!amountValid}
        onPress={onShow}
      />
      <Button
        testID="receive-more"
        variant="text"
        label={more ? t('payment:receive.less') : t('payment:receive.more')}
        onPress={() => setMore(!more)}
      />
      {more ? (
        <View className="gap-2">
          <AppText testID="receive-limits" variant="body" tone="muted">
            {t('payment:receive.limits', { max: maxText, window: windowText })}
          </AppText>
          <AppText variant="label" tone="muted">
            {t('payment:receive.bondLimit')}
          </AppText>
          {minimumText !== undefined ? (
            <AppText testID="receive-minimum" variant="label" tone="muted">
              {t('payment:receive.minimum', { amount: minimumText })}
            </AppText>
          ) : null}
        </View>
      ) : null}
    </>
  )
}
