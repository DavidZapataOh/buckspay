import * as Clipboard from 'expo-clipboard'
import { openURL } from 'expo-linking'
import { Platform, ToastAndroid, View } from 'react-native'
import { useNetwork } from '../features/network/use-network'
import { ellipsify } from '../utils/ellipsify'
import { AppText } from './app-text'
import { IconButton } from './icon-button'

async function copy(address: string) {
  await Clipboard.setStringAsync(address)
  // Android 13 and later confirm a copy themselves.
  if (Platform.OS === 'android' && Number(Platform.Version) < 33)
    ToastAndroid.show('Address copied', ToastAndroid.SHORT)
}

/** A labeled, shortened address with copy and explorer actions. */
export function AddressRow({ address, label, testID }: { address: string; label: string; testID?: string }) {
  const { getExplorerUrl } = useNetwork()
  return (
    <View testID={testID} className="min-h-14 flex-row items-center">
      <View accessible accessibilityLabel={`${label}: ${address}`} className="flex-1 py-2">
        <AppText variant="body">{label}</AppText>
        <AppText variant="label" tone="muted">
          {ellipsify(address)}
        </AppText>
      </View>
      <IconButton icon="content_copy" label="Copy address" onPress={() => void copy(address)} />
      <IconButton
        icon="open_in_new"
        label="Open in explorer"
        onPress={() => void openURL(getExplorerUrl(`address/${address}`))}
      />
    </View>
  )
}
