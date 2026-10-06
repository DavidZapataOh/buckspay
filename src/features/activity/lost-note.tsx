import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { safetyCode } from '../../payment/messages'
import { formatMoney } from '../../utils/format-amount'
import { copy, text } from '../payment/copy'

/** What a note that lost to a double spend says: who spent it twice, and what their bond lost. */
export function LostNote({
  hop,
  steps,
  culprit,
  burned,
  decimals,
  symbol,
  state,
}: {
  /** The culprit's spend, 0-based; `null` when the culprit is the issuer. */
  hop: number | null
  steps: number
  culprit: Uint8Array
  burned: bigint | null
  decimals: number
  symbol: string
  state: 'filed' | 'already' | 'late'
}) {
  const code = safetyCode({ type: 'device', key: culprit })
  const lost = copy.activity.lost
  return (
    <View className="gap-2" testID="lost-note">
      <AppText variant="headline">{lost.title}</AppText>
      <AppText variant="body">
        {hop === null
          ? text(lost.issuer, { code })
          : text(lost.culprit, { step: String(hop + 1), steps: String(steps), code })}
      </AppText>
      {state === 'late' ? <AppText variant="body">{lost.late}</AppText> : null}
      {state !== 'late' && burned !== null ? (
        <AppText variant="body">{text(lost.burned, { amount: formatMoney(burned, decimals), symbol })}</AppText>
      ) : null}
      {state === 'already' ? (
        <AppText variant="body" tone="muted">
          {lost.already}
        </AppText>
      ) : null}
    </View>
  )
}
