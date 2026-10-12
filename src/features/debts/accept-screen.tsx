import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { IouCause } from '../../protocol'

import type { OfferView } from './exchange'
import { balanceLine, formatDate, money, signedChange } from './format'

/** What the friend offers, against the balance this phone has now: the person signs, or declines. */
export function AcceptScreen({
  view,
  me,
  peerLabel,
  symbol,
  decimals,
  viaCode,
  busy,
  onSign,
  onDecline,
}: {
  view: OfferView
  me: Uint8Array
  peerLabel: string
  symbol: string
  decimals: number
  viaCode: boolean
  busy: boolean
  onSign: () => void
  onDecline: () => void
}) {
  const { t } = useTranslation(NAMESPACES)

  const { state } = view
  const repay = state.cause === IouCause.Repay
  const after = repay ? view.balance : view.balance + signedChange(me, state)
  return (
    <Screen testID="accept">
      <AppText variant="headline">{t('debts:acceptTitle')}</AppText>
      <View className="gap-1">
        <AppText variant="body">
          {t('debts:before', { line: balanceLine(peerLabel, view.balance, decimals, symbol) })}
        </AppText>
        <AppText variant="body">{t('debts:after', { line: balanceLine(peerLabel, after, decimals, symbol) })}</AppText>
        {repay ? (
          <View>
            <AppText variant="body">{t('debts:settling', { amount: money(state.amount, decimals, symbol) })}</AppText>
            <AppText variant="label" tone="muted">
              {t('debts:settlingDetail')}
            </AppText>
          </View>
        ) : null}
      </View>
      <AppText variant="label" tone="muted">
        {state.due === 0 ? t('debts:dueOnDemand') : t('debts:dueOn', { date: formatDate(state.due) })}
      </AppText>
      {view.memo ? <AppText variant="body">{view.memo}</AppText> : null}
      <AppText variant="label" tone="muted">
        {t('debts:signNote')}
      </AppText>
      {viaCode ? (
        <AppText variant="label" tone="muted">
          {t('debts:viaCode')}
        </AppText>
      ) : null}
      <View className="gap-2">
        <Button variant="filled" label={t('debts:sign')} busy={busy} onPress={onSign} />
        <Button variant="text" label={t('debts:decline')} disabled={busy} onPress={onDecline} />
      </View>
    </Screen>
  )
}
