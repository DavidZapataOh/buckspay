import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { IouCause } from '../../protocol'
import { debtsCopy } from './copy'
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
  const { state } = view
  const repay = state.cause === IouCause.Repay
  const after = repay ? view.balance : view.balance + signedChange(me, state)
  return (
    <Screen testID="accept">
      <AppText variant="headline">{debtsCopy.acceptTitle}</AppText>
      <View className="gap-1">
        <AppText variant="body">{debtsCopy.before(balanceLine(peerLabel, view.balance, decimals, symbol))}</AppText>
        <AppText variant="body">{debtsCopy.after(balanceLine(peerLabel, after, decimals, symbol))}</AppText>
        {repay ? (
          <View>
            <AppText variant="body">{debtsCopy.settling(money(state.amount, decimals, symbol))}</AppText>
            <AppText variant="label" tone="muted">
              {debtsCopy.settlingDetail}
            </AppText>
          </View>
        ) : null}
      </View>
      <AppText variant="label" tone="muted">
        {state.due === 0 ? debtsCopy.dueOnDemand : debtsCopy.dueOn(formatDate(state.due))}
      </AppText>
      {view.memo ? <AppText variant="body">{view.memo}</AppText> : null}
      <AppText variant="label" tone="muted">
        {debtsCopy.signNote}
      </AppText>
      {viaCode ? (
        <AppText variant="label" tone="muted">
          {debtsCopy.viaCode}
        </AppText>
      ) : null}
      <View className="gap-2">
        <Button variant="filled" label={debtsCopy.sign} busy={busy} onPress={onSign} />
        <Button variant="text" label={debtsCopy.decline} disabled={busy} onPress={onDecline} />
      </View>
    </Screen>
  )
}
