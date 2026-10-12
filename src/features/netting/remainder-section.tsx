import { useTranslation } from 'react-i18next'
import { Switch, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
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
      <AppText variant="title">{t('netting:remainder.title')}</AppText>
      <AppText variant="body" tone="muted">
        {t('netting:remainder.intro')}
      </AppText>
      {rows.map((row, index) => (
        <View key={row.tab} className="gap-2 py-2">
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
          {row.state === 'due' && row.role === 'creditor' ? (
            <AppText variant="body">{money(row.amount)}</AppText>
          ) : null}
          {row.state === 'sending' ? <AppText variant="body">{t('netting:remainder.sending')}</AppText> : null}
          {row.state === 'released' ? <AppText variant="body">{t('netting:remainder.released')}</AppText> : null}
          {row.state === 'settled' ? (
            <AppText variant="body" tone="success">
              {t('netting:remainder.settled')}
            </AppText>
          ) : null}
          {row.state === 'void' ? (
            <>
              <AppText variant="body" tone="danger">
                {t('netting:remainder.failed', { amount: money(row.amount) })}
              </AppText>
              {row.role === 'creditor' ? (
                <>
                  <AppText variant="label" tone="muted">
                    {t('netting:remainder.claimNote')}
                  </AppText>
                  <Button
                    testID={`remainder-claim-${index}`}
                    variant="tonal"
                    label={t('netting:remainder.claim')}
                    onPress={() => onClaimOptions?.(row.tab)}
                  />
                </>
              ) : null}
            </>
          ) : null}
          {row.state === 'undecided' ? <AppText variant="body">{t('netting:remainder.undecided')}</AppText> : null}
          {row.state === 'unknown' ? <AppText variant="body">{t('netting:remainder.unknown')}</AppText> : null}
        </View>
      ))}
      {holdsPayment && settleBy !== undefined ? (
        <AppText variant="body">{t('netting:remainder.settleBy', { date: formatDate(settleBy) })}</AppText>
      ) : null}
      <View className="min-h-12 flex-row items-center justify-between">
        <AppText variant="body">{t('netting:remainder.together')}</AppText>
        <Switch
          testID="netting-settle-together"
          accessibilityRole="switch"
          accessibilityLabel={t('netting:remainder.together')}
          value={settleTogether}
          onValueChange={(on: boolean) => onSettleTogether?.(on)}
        />
      </View>
      <AppText variant="label" tone="muted">
        {t('netting:remainder.togetherNote')}
      </AppText>
      {simplify ? (
        <View className="gap-2">
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
