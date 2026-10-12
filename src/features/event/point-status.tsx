import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { AppText } from '../../components/app-text'

import type { SyncStatus } from './point-sync'

/** How far this point is from the others: who it is linked to and how long ago it last heard them. */
export function PointStatus({ status, now }: { status: SyncStatus; now: number }) {
  const { t } = useTranslation(NAMESPACES)

  const message =
    status.peers === 0
      ? t('event:noPeers')
      : status.syncedAt === null
        ? t('event:waiting', { count: status.peers })
        : t('event:synced', { count: status.peers, seconds: Math.max(0, now - status.syncedAt) })
  return (
    <AppText testID="point-status" variant="body" tone="muted" accessibilityLiveRegion="polite">
      {message}
    </AppText>
  )
}
