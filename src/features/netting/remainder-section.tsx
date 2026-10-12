import { useTranslation } from 'react-i18next'
import { Switch, View } from 'react-native'
import { Amount } from '../../components/amount'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import { Info } from '../../components/info'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { formatMoney } from '../../i18n/format'
import { formatDate } from '../debts/format'

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
  const { t } = useTranslation(NAMESPACES)
  const money = (units: bigint) => `${formatMoney(units, decimals, currentLanguage())} ${symbol}`
  const holdsPayment = rows.some((row) => row.role === 'creditor' && row.state === 'released')
  return (
    <View className="gap-3">
      <View className="flex-row items-center justify-between">
        <AppText variant="title">{t('netting:remainder.title')}</AppText>
        <Info
          title={t('netting:remainder.title')}
          lines={[
            t('netting:remainder.intro'),
            ...(holdsPayment && settleBy !== undefined
              ? [t('netting:remainder.settleBy', { date: formatDate(settleBy) })]
              : []),
          ]}
        />
      </View>
      {rows.map((row, index) => (
        <View key={row.tab} className="gap-3 rounded-3xl border border-outline bg-surface p-5">
          <Amount
            size="row"
            value={formatMoney(row.amount, decimals, currentLanguage())}
            symbol={symbol}
            tone={row.role === 'creditor' ? 'success' : 'strong'}
          />
          {row.state === 'due' && row.role === 'debtor' ? (
            <>
              <Button
                testID={`remainder-pay-${index}`}
                variant="filled"
                label={t('netting:remainder.pay', { amount: money(row.amount) })}
                onPress={() => onPay?.(row.tab)}
              />
              <Button
                testID={`remainder-later-${index}`}
                variant="text"
                label={t('netting:remainder.later')}
                onPress={() => onLater?.(row.tab)}
              />
            </>
          ) : null}
          {row.state === 'sending' ? <Chip center kind="waiting" label={t('netting:remainder.sending')} /> : null}
          {row.state === 'released' ? <Chip center kind="waiting" label={t('netting:remainder.released')} /> : null}
          {row.state === 'settled' ? <Chip center kind="done" label={t('netting:remainder.settled')} /> : null}
          {row.state === 'void' ? (
            <>
              <Chip center kind="problem" label={t('netting:remainder.failed', { amount: money(row.amount) })} />
              {row.role === 'creditor' ? (
                <View className="flex-row items-center justify-center gap-1">
                  <Button
                    testID={`remainder-claim-${index}`}
                    variant="tonal"
                    label={t('netting:remainder.claim')}
                    onPress={() => onClaimOptions?.(row.tab)}
                  />
                  <Info title={t('netting:remainder.claim')} lines={[t('netting:remainder.claimNote')]} />
                </View>
              ) : null}
            </>
          ) : null}
          {row.state === 'undecided' ? <Chip center kind="waiting" label={t('netting:remainder.undecided')} /> : null}
          {row.state === 'unknown' ? <Chip center kind="waiting" label={t('netting:remainder.unknown')} /> : null}
        </View>
      ))}
      <View className="min-h-12 flex-row items-center justify-between gap-2">
        <View className="flex-1">
          <AppText variant="body">{t('netting:remainder.together')}</AppText>
        </View>
        <Switch
          testID="netting-settle-together"
          accessibilityRole="switch"
          accessibilityLabel={t('netting:remainder.together')}
          value={settleTogether}
          onValueChange={(on: boolean) => onSettleTogether?.(on)}
        />
        <Info title={t('netting:remainder.together')} lines={[t('netting:remainder.togetherNote')]} />
      </View>
      {simplify ? (
        <View className="gap-2 rounded-3xl border border-outline bg-surface p-5">
          <AppText variant="title">{t('netting:remainder.fewer')}</AppText>
          <AppText variant="body">
            {t('netting:remainder.simplify', { path: simplify.path, from: simplify.from, to: simplify.to })}
          </AppText>
          <Button
            testID="simplify-approve"
            variant="tonal"
            label={t('netting:remainder.approve')}
            onPress={() => onApproveSimplify?.(simplify.id, true)}
          />
        </View>
      ) : null}
    </View>
  )
}
