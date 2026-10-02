import AsyncStorage from '@react-native-async-storage/async-storage'
import type { SolanaClusterId, WalletAuthorization, WalletAuthorizationCache } from '@wallet-ui/react-native-kit'

/** The persisted wallet authorization of `chain`, so a build for another network never reuses its token. */
export function createAuthorizationCache(chain: SolanaClusterId): WalletAuthorizationCache {
  const key = `auth:${chain}`
  return {
    async clear() {
      await AsyncStorage.removeItem(key)
    },
    async get() {
      const stored = await AsyncStorage.getItem(key)
      if (!stored) return undefined
      try {
        return JSON.parse(stored) as WalletAuthorization
      } catch {
        return undefined
      }
    },
    async set(authorization) {
      await AsyncStorage.setItem(key, JSON.stringify(authorization))
    },
  }
}
