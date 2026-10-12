import { useTranslation } from 'react-i18next'
import { View } from 'react-native'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import { Hero } from '../../components/hero'
import { Info } from '../../components/info'
import { Screen } from '../../components/screen'
import { Stage } from '../../components/stage'
import { NAMESPACES } from '../../i18n'
import { RemainderSection, type RemainderRow, type SimplifyPrompt } from './remainder-section'
import { heroOf, sessionStep, type SessionView } from './session-view'

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
  const hero = heroOf(view)
  return (
    <Screen testID="netting-session" steps={{ total: 3, current: sessionStep(view.state) }}>
      <Stage
        hero={<Hero kind={hero === 'nearby' ? 'waiting' : hero} decorative />}
        title={view.headline}
        tone={view.tone === 'success' ? 'success' : view.tone === 'danger' ? 'danger' : undefined}
        line={view.line}
      >
        <Info
          title={view.headline}
          lines={[view.body, t('netting:privacy.fee'), t('netting:privacy.hidden'), t('netting:privacy.chain')]}
        />
      </Stage>
      {proofLine ? (
        <View className="items-center">
          <Chip center kind="problem" label={proofLine} />
        </View>
      ) : null}
      {fee && view.state === 'agreed' ? (
        <Button
          testID="netting-pay-fee"
          variant="tonal"
          label={t('netting:payFee')}
          onPress={() => handlers.onPayFee?.()}
        />
      ) : null}
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
