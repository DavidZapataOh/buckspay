import AsyncStorage from '@react-native-async-storage/async-storage'

const STORE = 'mesh-permissions:v1'

/** The permission screen opens once on a fresh install, before onboarding. */
export async function hasSeenPermissions(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(STORE)) === 'seen'
  } catch {
    return true
  }
}

export const markPermissionsSeen = () => AsyncStorage.setItem(STORE, 'seen')
