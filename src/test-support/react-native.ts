// Test double for react-native, which cannot load in Vitest (its sources are Flow).
export const AppState = { addEventListener: () => ({ remove: () => {} }) }
