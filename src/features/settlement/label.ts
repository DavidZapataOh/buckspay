import AsyncStorage from '@react-native-async-storage/async-storage'

const KEY = 'settlement:label-v1'

/** Whether the person has read what settling in the clear publishes and said to go on. */
export async function isLabelAcknowledged(): Promise<boolean> {
  return (await AsyncStorage.getItem(KEY)) === '1'
}

export const acknowledgeLabel = () => AsyncStorage.setItem(KEY, '1')
