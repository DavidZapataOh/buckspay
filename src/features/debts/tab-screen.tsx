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
import { Tile } from '../../components/tile'
import { IouCause } from '../../protocol'

import { tabNumber } from './debts-screen'
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

/** One debt: the number, who, what is happening to it, and what can be done next. */
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
  const even = summary.direction === 'settled'
  return (
    <Screen testID="tab">
      <Stage
        hero={<Hero kind={even ? 'done' : 'coins'} decorative size={120} />}
        title={peer}
        tone={even ? 'success' : undefined}
      >
        {even ? (
          <Chip center kind="done" label={t('debts:evenShort')} />
        ) : (
          <>
            <Amount
              value={`${summary.direction === 'owed' ? '+' : '−'}${tabNumber(summary, decimals, symbol)}`}
              symbol={symbol}
              tone={summary.direction === 'owed' ? 'success' : 'strong'}
            />
            <AppText variant="body" tone="muted">
              {summary.direction === 'owed' ? t('debts:owesYou') : t('debts:youOwe')}
            </AppText>
          </>
        )}
        <View className="flex-row items-center gap-1">
          <Chip center kind="info" icon="tag" label={t('debts:record', { code: summary.recordCode })} />
          <Info title={t('debts:record', { code: summary.recordCode })} lines={[t('debts:recordHelp')]} />
        </View>
      </Stage>
      {summary.settling ? (
        <View className="flex-row items-center justify-center gap-1">
          <Chip
            center
            kind="waiting"
            label={
              summary.settlingReceived
                ? t('debts:settlingReceived', {
                    peer: summary.peerLabel,
                    amount: money(summary.settlingAmount, decimals, symbol),
                  })
                : t('debts:settling', { amount: money(summary.settlingAmount, decimals, symbol) })
            }
          />
          <Info title={t('debts:settlingShort', { amount: '' })} lines={[t('debts:settlingDetail')]} />
        </View>
      ) : null}
      {nettings.map((netting, index) => (
        <Chip
          center
          key={index}
          kind="done"
          label={t('debts:netted', {
            amount: money(netting.cancel, decimals, symbol),
            date: formatDate(netting.recordedAt),
          })}
        />
      ))}
      {summary.locked ? <Chip center kind="waiting" label={t('debts:locked')} /> : null}
      {summary.orphaned ? <Chip center kind="problem" label={t('debts:orphaned')} /> : null}
      {summary.waiting ? (
        <View className="items-center gap-2">
          <View className="flex-row items-center gap-1">
            <Chip center kind="waiting" label={t('debts:waiting', { peer })} />
            <Info
              title={t('debts:waiting', { peer })}
              lines={[t('debts:notSigned', { peer }), t('debts:stillValid')]}
            />
          </View>
          <Button variant="tonal" label={t('debts:actions.resend')} busy={busy} onPress={onResend} />
        </View>
      ) : null}
      {summary.direction === 'owe' && onRepay ? (
        <View className="gap-2">
          <Button variant="filled" label={t('debts:payWithBuckspay')} disabled={busy} onPress={onRepay} />
          <AppText variant="label" tone="muted" className="text-center">
            {t('debts:repayNote')}
          </AppText>
        </View>
      ) : null}
      <View className="gap-3">
        <View className="flex-row gap-3">
          <View className="flex-1">
            <Tile icon="north_east" title={t('debts:actions.lent')} onPress={() => !busy && onChange('lent')} />
          </View>
          <View className="flex-1">
            <Tile icon="south_west" title={t('debts:actions.borrowed')} onPress={() => !busy && onChange('borrowed')} />
          </View>
        </View>
        <View className="flex-row gap-3">
          <View className="flex-1">
            <Tile icon="check_circle" title={t('debts:actions.repaid')} onPress={() => !busy && onChange('repaid')} />
          </View>
          <View className="flex-1">
            {summary.pending ? null : (
              <Tile icon="close" title={t('debts:actions.clear')} onPress={() => !busy && onChange('clear')} />
            )}
          </View>
        </View>
        {summary.pending ? (
          <AppText variant="label" tone="muted" className="text-center">
            {t('debts:clearPending')}
          </AppText>
        ) : null}
      </View>
      {history.map((row) => {
        const change = signedChange(me, { ...row.iou })
        const signed = row.debtorSig !== null && row.creditorSig !== null
        return (
          <View key={row.iou.seq} className="gap-1 rounded-3xl border border-outline bg-surface p-4">
            <AppText variant="body">
              {`#${row.iou.seq} · ${withSign(change, decimals, symbol)} · ${t(`debts:cause.${CAUSE[row.iou.cause as keyof typeof CAUSE]}`)}`}
            </AppText>
            {row.memo ? (
              <AppText variant="label" tone="muted">
                {row.memo}
              </AppText>
            ) : null}
            {!signed ? <Chip kind="waiting" label={t('debts:waiting', { peer })} /> : null}
          </View>
        )
      })}
    </Screen>
  )
}
