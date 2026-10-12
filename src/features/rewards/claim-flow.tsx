import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'

/** What a claim does and who sees it, with the delayed claim as the default and an explicit way to send at once. */
export function ClaimConfirm({
  busy,
  onClaim,
  onCancel,
}: {
  busy: boolean
  onClaim: (immediate: boolean) => void
  onCancel: () => void
}) {
  const { t } = useTranslation(NAMESPACES)

  return (
    <View testID="claim-confirm" className="gap-3">
      <AppText variant="title" accessibilityRole="header">
        {t('rewards:claimTitle')}
      </AppText>
      <AppText variant="body">{t('rewards:claimBody')}</AppText>
      <AppText variant="label" tone="muted">
        {t('rewards:claimDelayedNote')}
      </AppText>
      <Button variant="filled" label={t('rewards:claimDelayed')} busy={busy} onPress={() => onClaim(false)} />
      <AppText variant="label" tone="muted">
        {t('rewards:claimNowNote')}
      </AppText>
      <Button variant="tonal" label={t('rewards:claimNow')} disabled={busy} onPress={() => onClaim(true)} />
      <Button variant="text" label={t('rewards:cancel')} disabled={busy} onPress={onCancel} />
    </View>
  )
}

/** The warning that moving claimed rewards to the wallet links them to it. */
export function MoveConfirm({ busy, onMove, onCancel }: { busy: boolean; onMove: () => void; onCancel: () => void }) {
  const { t } = useTranslation(NAMESPACES)

  return (
    <View testID="move-confirm" className="gap-3">
      <AppText variant="body">{t('rewards:moveWarning')}</AppText>
      <Button variant="danger" label={t('rewards:moveAnyway')} busy={busy} onPress={onMove} />
      <Button variant="text" label={t('rewards:cancel')} disabled={busy} onPress={onCancel} />
    </View>
  )
}
