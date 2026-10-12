import { useTranslation } from 'react-i18next'
import { i18n, NAMESPACES } from '../../i18n'
import { View } from 'react-native'
import { Button } from '../../components/button'
import { ListRow } from '../../components/list-row'
import type { KeyState } from './native'

export type PrivateDataProps = {
  state: KeyState | 'unavailable'
  /** 0 to 1 while downloading. */
  progress: number
  sizeBytes: number
  onDownload: () => void
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`

const valueOf = ({ state, progress, sizeBytes }: PrivateDataProps) => {
  switch (state) {
    case 'ready':
      return i18n.t('zk:privateData.ready', { size: megabytes(sizeBytes) })
    case 'downloading':
      return i18n.t('zk:privateData.downloading', { percent: `${Math.round(progress * 100)}%` })
    case 'expanding':
      return i18n.t('zk:privateData.preparing')
    case 'missing':
      return i18n.t('zk:privateData.missing', { size: '282 MB' })
    case 'unavailable':
      return i18n.t('zk:privateData.unavailable')
  }
}

/** The data private settlement needs: where it stands, and a way to fetch it now instead of on Wi-Fi while charging. */
export function PrivateDataRow(props: PrivateDataProps) {
  const { t } = useTranslation(NAMESPACES)

  return (
    <View testID="private-data" className="gap-2">
      <ListRow testID="private-data-status" title={t('zk:privateData.title')} value={valueOf(props)} />
      {props.state === 'missing' ? (
        <Button
          testID="private-data-download"
          variant="text"
          label={t('zk:privateData.download')}
          onPress={props.onDownload}
        />
      ) : null}
    </View>
  )
}
