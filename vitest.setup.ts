import { vi } from 'vitest'

// The language core loads these native modules; Vitest cannot, so every test gets the same doubles the screens' tests already use.
vi.mock('react-native', () => import('./src/test-support/react-native'))
vi.mock('@react-native-async-storage/async-storage', () => import('./src/test-support/async-storage'))
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }))
