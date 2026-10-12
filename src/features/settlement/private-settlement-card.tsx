import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { privateSettlementText } from '../zk/copy'
import type { PrivateSettlementState } from '../zk/types'

/** What the note is doing on the private route, and the two things the person can do about it. */
export function PrivateSettlementCard({
  state,
  clearAllowed,
  onSettleNow,
  onSettleInClear,
}: {
  state: PrivateSettlementState
  clearAllowed: boolean
  onSettleNow: () => void
  onSettleInClear: () => void
}) {
  const { t } = useTranslation(NAMESPACES)

  const canHurry = state.kind === 'needs-key' || state.kind === 'waiting-for-charger' || state.kind === 'ready'
  return (
    <View testID="private-settlement" className="gap-3 rounded-3xl bg-surface p-5">
      <AppText variant="title" accessibilityRole="header">
        {t('zk:title')}
      </AppText>
      <AppText variant="body">{privateSettlementText(state)}</AppText>
      <AppText variant="label" tone="muted">
        {t('zk:scope')}
      </AppText>
      <View className="flex-row gap-3">
        {canHurry ? (
          <Button
            testID="private-settle-now"
            variant="filled"
            label={state.kind === 'needs-key' ? t('zk:downloadNow') : t('zk:settleNow')}
            onPress={onSettleNow}
          />
        ) : null}
        {clearAllowed ? (
          <Button
            testID="private-settle-clear"
            variant="text"
            label={t('zk:settleInClear')}
            onPress={onSettleInClear}
          />
        ) : null}
      </View>
      {clearAllowed ? (
        <AppText variant="label" tone="muted">
          {t('zk:clearPublishes')}
        </AppText>
      ) : null}
    </View>
  )
}
