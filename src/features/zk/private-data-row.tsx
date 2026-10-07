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
      return `Ready · ${megabytes(sizeBytes)} on this phone`
    case 'downloading':
      return `Downloading · ${Math.round(progress * 100)}%`
    case 'expanding':
      return 'Preparing'
    case 'missing':
      return 'Not downloaded · about 282 MB'
    case 'unavailable':
      return 'Unavailable'
  }
}

/** The data private settlement needs: where it stands, and a way to fetch it now instead of on Wi-Fi while charging. */
export function PrivateDataRow(props: PrivateDataProps) {
  return (
    <View testID="private-data" className="gap-2">
      <ListRow testID="private-data-status" title="Private settlement data" value={valueOf(props)} />
      {props.state === 'missing' ? (
        <Button testID="private-data-download" variant="text" label="Download now" onPress={props.onDownload} />
      ) : null}
    </View>
  )
}
