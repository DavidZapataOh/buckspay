// Test double for react-native, which cannot load in Vitest (its sources are Flow): the host
// components the app uses, rendered by name as React Native's own Jest setup does, and the APIs it calls.
export const ActivityIndicator = 'ActivityIndicator'
export const Image = 'Image'
export const Pressable = 'Pressable'
export const ScrollView = 'ScrollView'
export const Text = 'Text'
export const View = 'View'

export const AppState = { addEventListener: () => ({ remove: () => {} }) }
export const Platform = { OS: 'android', Version: 36 }
export const ToastAndroid = { SHORT: 0, show: (_message: string, _duration: number) => {} }
export const TextInput = 'TextInput'
export const PixelRatio = { get: () => 1, getPixelSizeForLayoutSize: (size: number) => size }
export const Linking = { openSettings: async () => {} }
export const StyleSheet = { absoluteFill: {} }
export const AccessibilityInfo = { announceForAccessibility: (_message: string) => {} }
