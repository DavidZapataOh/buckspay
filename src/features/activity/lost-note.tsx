import { formatMoney } from '../../i18n/format'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Chip } from '../../components/chip'
import { safetyCode } from '../../payment/messages'

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
  const { t } = useTranslation(NAMESPACES)

  const code = safetyCode({ type: 'device', key: culprit })
  return (
    <View className="gap-2 rounded-3xl border border-danger bg-danger-container p-5" testID="lost-note">
      <Chip kind="problem" label={t('payment:activity.lost.title')} />
      <AppText variant="body">
        {hop === null
          ? t('payment:activity.lost.issuer', { code })
          : t('payment:activity.lost.culprit', { step: String(hop + 1), steps: String(steps), code })}
      </AppText>
      {state === 'late' ? <AppText variant="body">{t('payment:activity.lost.late')}</AppText> : null}
      {state !== 'late' && burned !== null ? (
        <AppText variant="body">
          {t('payment:activity.lost.burned', { amount: formatMoney(burned, decimals, currentLanguage()), symbol })}
        </AppText>
      ) : null}
      {state === 'already' ? (
        <AppText variant="body" tone="muted">
          {t('payment:activity.lost.already')}
        </AppText>
      ) : null}
    </View>
  )
}
