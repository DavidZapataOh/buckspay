import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { IouCause } from '../../protocol'

import { tabSentence } from './debts-screen'
import { formatDate, money, signedChange, type TabSummary } from './format'
import type { StateRow } from './store'

export type TabAction = 'lent' | 'borrowed' | 'repaid' | 'clear'

const CAUSE = {
  [IouCause.Open]: 'open',
  [IouCause.Repay]: 'repay',
  [IouCause.Outside]: 'outside',
} as const

const withSign = (units: bigint, decimals: number, symbol: string) =>
  `${units < 0n ? '−' : '+'}${money(units < 0n ? -units : units, decimals, symbol)}`

/** One debt: where it stands, what changed, and what can be done next. */
export function TabScreen({
  summary,
  history,
  nettings,
  me,
  symbol,
  decimals,
  busy,
  onChange,
  onRepay,
  onResend,
}: {
  summary: TabSummary
  /** Newest first, one-sided states included. */
  history: readonly StateRow[]
  nettings: readonly { cancel: bigint; recordedAt: number }[]
  me: Uint8Array
  symbol: string
  decimals: number
  busy: boolean
  onChange: (action: TabAction) => void
  /** Offered to a debtor when this phone can build the payment; the debt goes down only once the payment settles. */
  onRepay?: () => void
  onResend: () => void
}) {
  const { t } = useTranslation(NAMESPACES)

  const peer = summary.peerLabel
  return (
    <Screen testID="tab">
      <AppText variant="headline">{tabSentence(summary, decimals, symbol)}</AppText>
      <AppText variant="label" tone="muted">
        {t('debts:record', { code: summary.recordCode })}
      </AppText>
      <AppText variant="label" tone="muted">
        {t('debts:recordHelp')}
      </AppText>
      {summary.settling ? (
        <View>
          <AppText variant="body">
            {summary.settlingReceived
              ? t('debts:settlingReceived', {
                  peer: summary.peerLabel,
                  amount: money(summary.settlingAmount, decimals, symbol),
                })
              : t('debts:settling', { amount: money(summary.settlingAmount, decimals, symbol) })}
          </AppText>
          <AppText variant="label" tone="muted">
            {t('debts:settlingDetail')}
          </AppText>
        </View>
      ) : null}
      {nettings.map((netting, index) => (
        <AppText key={index} variant="body" tone="success">
          {t('debts:netted', { amount: money(netting.cancel, decimals, symbol), date: formatDate(netting.recordedAt) })}
        </AppText>
      ))}
      {summary.locked ? (
        <AppText variant="label" tone="muted">
          {t('debts:locked')}
        </AppText>
      ) : null}
      {summary.orphaned ? (
        <AppText variant="label" tone="danger">
          {t('debts:orphaned')}
        </AppText>
      ) : null}
      {summary.waiting ? (
        <View className="gap-2">
          <AppText variant="body">{t('debts:notSigned', { peer: peer })}</AppText>
          <AppText variant="label" tone="muted">
            {t('debts:stillValid')}
          </AppText>
          <Button variant="tonal" label={t('debts:actions.resend')} busy={busy} onPress={onResend} />
        </View>
      ) : null}
      <View className="gap-2">
        <Button variant="tonal" label={t('debts:actions.lent')} disabled={busy} onPress={() => onChange('lent')} />
        <Button
          variant="tonal"
          label={t('debts:actions.borrowed')}
          disabled={busy}
          onPress={() => onChange('borrowed')}
        />
        <Button variant="tonal" label={t('debts:actions.repaid')} disabled={busy} onPress={() => onChange('repaid')} />
        <Button
          variant="tonal"
          label={t('debts:actions.clear')}
          disabled={busy || summary.pending}
          onPress={() => onChange('clear')}
        />
        {summary.pending ? (
          <AppText variant="label" tone="muted">
            {t('debts:clearPending')}
          </AppText>
        ) : null}
        {summary.direction === 'owe' && onRepay ? (
          <View className="gap-2">
            <Button variant="filled" label={t('debts:payWithBuckspay')} disabled={busy} onPress={onRepay} />
            <AppText variant="label" tone="muted">
              {t('debts:repayNote')}
            </AppText>
          </View>
        ) : null}
      </View>
      {history.map((row) => {
        const change = signedChange(me, { ...row.iou })
        const signed = row.debtorSig !== null && row.creditorSig !== null
        return (
          <View key={row.iou.seq} className="min-h-12 justify-center py-1">
            <AppText variant="body">
              {`#${row.iou.seq} · ${withSign(change, decimals, symbol)} · ${t(`debts:cause.${CAUSE[row.iou.cause as keyof typeof CAUSE]}`)}`}
            </AppText>
            {row.memo ? (
              <AppText variant="label" tone="muted">
                {row.memo}
              </AppText>
            ) : null}
            {!signed ? (
              <AppText variant="label" tone="muted">
                {t('debts:waiting', { peer: peer })}
              </AppText>
            ) : null}
          </View>
        )
      })}
    </Screen>
  )
}
