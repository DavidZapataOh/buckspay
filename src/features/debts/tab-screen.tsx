import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { IouCause } from '../../protocol'
import { debtsCopy } from './copy'
import { tabSentence } from './debts-screen'
import { formatDate, money, signedChange, type TabSummary } from './format'
import type { StateRow } from './store'

export type TabAction = 'lent' | 'borrowed' | 'repaid' | 'clear'

const CAUSE = {
  [IouCause.Open]: 'Added',
  [IouCause.Repay]: 'Paid with Buckspay',
  [IouCause.Outside]: 'Paid outside Buckspay',
}

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
  const peer = summary.peerLabel
  return (
    <Screen testID="tab">
      <AppText variant="headline">{tabSentence(summary, decimals, symbol)}</AppText>
      <AppText variant="label" tone="muted">
        {debtsCopy.record(summary.recordCode)}
      </AppText>
      <AppText variant="label" tone="muted">
        {debtsCopy.recordHelp}
      </AppText>
      {summary.settling ? (
        <View>
          <AppText variant="body">{debtsCopy.settling(money(summary.settlingAmount, decimals, symbol))}</AppText>
          <AppText variant="label" tone="muted">
            {debtsCopy.settlingDetail}
          </AppText>
        </View>
      ) : null}
      {nettings.map((netting, index) => (
        <AppText key={index} variant="body" tone="success">
          {debtsCopy.netted(money(netting.cancel, decimals, symbol), formatDate(netting.recordedAt))}
        </AppText>
      ))}
      {summary.locked ? (
        <AppText variant="label" tone="muted">
          {debtsCopy.locked}
        </AppText>
      ) : null}
      {summary.orphaned ? (
        <AppText variant="label" tone="danger">
          {debtsCopy.orphaned}
        </AppText>
      ) : null}
      {summary.waiting ? (
        <View className="gap-2">
          <AppText variant="body">{debtsCopy.notSigned(peer)}</AppText>
          <AppText variant="label" tone="muted">
            {debtsCopy.stillValid}
          </AppText>
          <Button variant="tonal" label={debtsCopy.actions.resend} busy={busy} onPress={onResend} />
        </View>
      ) : null}
      <View className="gap-2">
        <Button variant="tonal" label={debtsCopy.actions.lent} disabled={busy} onPress={() => onChange('lent')} />
        <Button
          variant="tonal"
          label={debtsCopy.actions.borrowed}
          disabled={busy}
          onPress={() => onChange('borrowed')}
        />
        <Button variant="tonal" label={debtsCopy.actions.repaid} disabled={busy} onPress={() => onChange('repaid')} />
        <Button
          variant="tonal"
          label={debtsCopy.actions.clear}
          disabled={busy || summary.pending}
          onPress={() => onChange('clear')}
        />
        {summary.pending ? (
          <AppText variant="label" tone="muted">
            {debtsCopy.clearPending}
          </AppText>
        ) : null}
        {summary.direction === 'owe' && onRepay ? (
          <View className="gap-2">
            <Button variant="filled" label={debtsCopy.payWithBuckspay} disabled={busy} onPress={onRepay} />
            <AppText variant="label" tone="muted">
              {debtsCopy.repayNote}
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
              {`#${row.iou.seq} · ${withSign(change, decimals, symbol)} · ${CAUSE[row.iou.cause as keyof typeof CAUSE]}`}
            </AppText>
            {row.memo ? (
              <AppText variant="label" tone="muted">
                {row.memo}
              </AppText>
            ) : null}
            {!signed ? (
              <AppText variant="label" tone="muted">
                {debtsCopy.waiting(peer)}
              </AppText>
            ) : null}
          </View>
        )
      })}
    </Screen>
  )
}
