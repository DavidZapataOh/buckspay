import { useTranslation } from 'react-i18next'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { NAMESPACES } from '../../i18n'
import { RemainderSection, type RemainderRow, type SimplifyPrompt } from './remainder-section'
import type { SessionView } from './session-view'

export type SessionHandlers = {
  onPay?: (tab: string) => void
  onLater?: (tab: string) => void
  onClaimOptions?: (tab: string) => void
  onSettleTogether?: (on: boolean) => void
  onApproveSimplify?: (id: string, on: boolean) => void
  onPayFee?: () => void
}

export function SessionScreen({
  view,
  rows = [],
  settleTogether = false,
  settleBy,
  simplify,
  fee,
  symbol,
  decimals,
  ...handlers
}: SessionHandlers & {
  view: SessionView
  rows?: readonly RemainderRow[]
  settleTogether?: boolean
  settleBy?: number
  simplify?: SimplifyPrompt
  /** Given only when the free lane answered that it is capped. */
  fee?: { lamports: number }
  symbol: string
  decimals: number
}) {
  const { t } = useTranslation(NAMESPACES)
  const proofLine =
    view.state !== 'agreed'
      ? null
      : view.proof === 'invalid'
        ? t('netting:proof.invalid')
        : view.proof === 'missing'
          ? t('netting:proof.missing')
          : null
  return (
    <Screen testID="netting-session">
      <AppText variant="headline">{view.headline}</AppText>
      <AppText variant="body" tone={view.tone}>
        {view.body}
      </AppText>
      {proofLine ? (
        <AppText variant="body" tone="danger">
          {proofLine}
        </AppText>
      ) : null}
      {fee && view.state === 'agreed' ? (
        <Button
          testID="netting-pay-fee"
          variant="tonal"
          label={t('netting:payFee')}
          onPress={() => handlers.onPayFee?.()}
        />
      ) : null}
      <View className="gap-1">
        <AppText variant="label" tone="muted">
          {t('netting:privacy.fee')}
        </AppText>
        <AppText variant="label" tone="muted">
          {t('netting:privacy.hidden')}
        </AppText>
        <AppText variant="label" tone="muted">
          {t('netting:privacy.chain')}
        </AppText>
      </View>
      {rows.length > 0 || simplify ? (
        <RemainderSection
          rows={rows}
          symbol={symbol}
          decimals={decimals}
          settleTogether={settleTogether}
          settleBy={settleBy}
          simplify={simplify}
          {...handlers}
        />
      ) : null}
    </Screen>
  )
}
