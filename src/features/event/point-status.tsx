import { AppText } from '../../components/app-text'
import { text } from '../payment/copy'
import { eventCopy } from './copy'
import type { SyncStatus } from './point-sync'

/** How far this point is from the others: who it is linked to and how long ago it last heard them. */
export function PointStatus({ status, now }: { status: SyncStatus; now: number }) {
  const message =
    status.peers === 0
      ? eventCopy.noPeers
      : status.syncedAt === null
        ? text(eventCopy.waiting, { count: status.peers })
        : text(eventCopy.synced, { count: status.peers, seconds: Math.max(0, now - status.syncedAt) })
  return (
    <AppText testID="point-status" variant="body" tone="muted" accessibilityLiveRegion="polite">
      {message}
    </AppText>
  )
}
