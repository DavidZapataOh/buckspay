import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { View } from 'react-native'
import { Amount } from '../../components/amount'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import { Hero } from '../../components/hero'
import { Info } from '../../components/info'
import { Screen } from '../../components/screen'
import { Stage } from '../../components/stage'
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
  const change = repay ? 0n : signedChange(me, state)
  const after = repay ? view.balance : view.balance + change
  return (
    <Screen
      testID="accept"
      footer={
        <View className="gap-2">
          <Button variant="filled" label={t('debts:sign')} busy={busy} onPress={onSign} />
          <Button variant="text" label={t('debts:decline')} disabled={busy} onPress={onDecline} />
        </View>
      }
    >
      <Stage hero={<Hero kind="coins" decorative size={120} />} title={t('debts:acceptTitle')} line={peerLabel}>
        <Amount
          value={`${repay || change >= 0n ? '+' : '−'}${money(repay ? state.amount : change < 0n ? -change : change, decimals, symbol).replace(` ${symbol}`, '')}`}
          symbol={symbol}
          tone={repay || change >= 0n ? 'success' : 'strong'}
        />
      </Stage>
      <View className="gap-2 rounded-3xl border border-outline bg-surface p-5">
        <AppText variant="label" tone="muted">
          {t('debts:before', { line: balanceLine(peerLabel, view.balance, decimals, symbol) })}
        </AppText>
        <AppText variant="body">{t('debts:after', { line: balanceLine(peerLabel, after, decimals, symbol) })}</AppText>
        {view.memo ? <AppText variant="body">{`“${view.memo}”`}</AppText> : null}
      </View>
      <View className="items-center gap-2">
        {repay ? (
          <View className="flex-row items-center gap-1">
            <Chip
              center
              kind="waiting"
              label={t('debts:settling', { amount: money(state.amount, decimals, symbol) })}
            />
            <Info title={t('debts:settlingShort', { amount: '' })} lines={[t('debts:settlingDetail')]} />
          </View>
        ) : null}
        <View className="flex-row items-center gap-1">
          <Chip
            center
            kind="info"
            icon="event"
            label={state.due === 0 ? t('debts:dueOnDemand') : t('debts:dueOn', { date: formatDate(state.due) })}
          />
          <Info title={t('debts:acceptTitle')} lines={[t('debts:signNote')]} />
        </View>
        {viaCode ? <Chip center kind="waiting" label={t('debts:viaCodeShort')} /> : null}
      </View>
    </Screen>
  )
}
