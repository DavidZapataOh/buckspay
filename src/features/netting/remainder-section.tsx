import { Switch, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { formatMoney } from '../../utils/format-amount'
import { fill, nettingCopy } from './copy'

export type RemainderState = 'due' | 'sending' | 'released' | 'settled' | 'void' | 'undecided' | 'unknown'
export type RemainderRow = { tab: string; role: 'debtor' | 'creditor'; amount: bigint; state: RemainderState }
export type SimplifyPrompt = { id: string; path: string; from: string; to: string }

export function RemainderSection({
  rows,
  symbol,
  decimals,
  settleTogether,
  settleBy,
  simplify,
  onPay,
  onLater,
  onClaimOptions,
  onSettleTogether,
  onApproveSimplify,
}: {
  rows: readonly RemainderRow[]
  symbol: string
  decimals: number
  settleTogether: boolean
  settleBy?: number
  simplify?: SimplifyPrompt
  onPay?: (tab: string) => void
  onLater?: (tab: string) => void
  onClaimOptions?: (tab: string) => void
  onSettleTogether?: (on: boolean) => void
  onApproveSimplify?: (id: string, on: boolean) => void
}) {
  const r = nettingCopy.remainder
  const money = (units: bigint) => `${formatMoney(units, decimals)} ${symbol}`
  const holdsPayment = rows.some((row) => row.role === 'creditor' && row.state === 'released')
  return (
    <View className="gap-3">
      <AppText variant="title">{r.title}</AppText>
      <AppText variant="body" tone="muted">
        {r.intro}
      </AppText>
      {rows.map((row, index) => (
        <View key={row.tab} className="gap-2 py-2">
          {row.state === 'due' && row.role === 'debtor' ? (
            <>
              <Button
                testID={`remainder-pay-${index}`}
                variant="filled"
                label={fill(r.pay, { amount: money(row.amount) })}
                onPress={() => onPay?.(row.tab)}
              />
              <Button
                testID={`remainder-later-${index}`}
                variant="text"
                label={r.later}
                onPress={() => onLater?.(row.tab)}
              />
            </>
          ) : null}
          {row.state === 'due' && row.role === 'creditor' ? (
            <AppText variant="body">{money(row.amount)}</AppText>
          ) : null}
          {row.state === 'sending' ? <AppText variant="body">{r.sending}</AppText> : null}
          {row.state === 'released' ? <AppText variant="body">{r.released}</AppText> : null}
          {row.state === 'settled' ? (
            <AppText variant="body" tone="success">
              {r.settled}
            </AppText>
          ) : null}
          {row.state === 'void' ? (
            <>
              <AppText variant="body" tone="danger">
                {fill(r.failed, { amount: money(row.amount) })}
              </AppText>
              {row.role === 'creditor' ? (
                <>
                  <AppText variant="label" tone="muted">
                    {r.claimNote}
                  </AppText>
                  <Button
                    testID={`remainder-claim-${index}`}
                    variant="tonal"
                    label={r.claim}
                    onPress={() => onClaimOptions?.(row.tab)}
                  />
                </>
              ) : null}
            </>
          ) : null}
          {row.state === 'undecided' ? <AppText variant="body">{r.undecided}</AppText> : null}
          {row.state === 'unknown' ? <AppText variant="body">{r.unknown}</AppText> : null}
        </View>
      ))}
      {holdsPayment && settleBy !== undefined ? (
        <AppText variant="body">{fill(r.settleBy, { date: new Date(settleBy * 1000).toLocaleDateString() })}</AppText>
      ) : null}
      <View className="min-h-12 flex-row items-center justify-between">
        <AppText variant="body">{r.together}</AppText>
        <Switch
          testID="netting-settle-together"
          accessibilityRole="switch"
          accessibilityLabel={r.together}
          value={settleTogether}
          onValueChange={(on: boolean) => onSettleTogether?.(on)}
        />
      </View>
      <AppText variant="label" tone="muted">
        {r.togetherNote}
      </AppText>
      {simplify ? (
        <View className="gap-2">
          <AppText variant="title">{r.fewer}</AppText>
          <AppText variant="body">
            {fill(r.simplify, { path: simplify.path, A: simplify.from, C: simplify.to })}
          </AppText>
          <Button
            testID="simplify-approve"
            variant="tonal"
            label={r.approve}
            onPress={() => onApproveSimplify?.(simplify.id, true)}
          />
        </View>
      ) : null}
    </View>
  )
}
