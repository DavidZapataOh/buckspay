import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { rewardsCopy } from './copy'

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
  return (
    <View testID="claim-confirm" className="gap-3">
      <AppText variant="title" accessibilityRole="header">
        {rewardsCopy.claimTitle}
      </AppText>
      <AppText variant="body">{rewardsCopy.claimBody}</AppText>
      <AppText variant="label" tone="muted">
        {rewardsCopy.claimDelayedNote}
      </AppText>
      <Button variant="filled" label={rewardsCopy.claimDelayed} busy={busy} onPress={() => onClaim(false)} />
      <AppText variant="label" tone="muted">
        {rewardsCopy.claimNowNote}
      </AppText>
      <Button variant="tonal" label={rewardsCopy.claimNow} disabled={busy} onPress={() => onClaim(true)} />
      <Button variant="text" label={rewardsCopy.cancel} disabled={busy} onPress={onCancel} />
    </View>
  )
}

/** The warning that moving claimed rewards to the wallet links them to it. */
export function MoveConfirm({ busy, onMove, onCancel }: { busy: boolean; onMove: () => void; onCancel: () => void }) {
  return (
    <View testID="move-confirm" className="gap-3">
      <AppText variant="body">{rewardsCopy.moveWarning}</AppText>
      <Button variant="danger" label={rewardsCopy.moveAnyway} busy={busy} onPress={onMove} />
      <Button variant="text" label={rewardsCopy.cancel} disabled={busy} onPress={onCancel} />
    </View>
  )
}
