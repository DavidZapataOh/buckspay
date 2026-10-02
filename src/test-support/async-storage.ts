// In-memory test double for AsyncStorage, whose native module cannot load in Vitest.
const items = new Map<string, string>()

export const storedItems = () => Object.fromEntries(items)
export const resetAsyncStorage = () => items.clear()

export default {
  async getItem(key: string): Promise<string | null> {
    return items.get(key) ?? null
  },
  async setItem(key: string, value: string): Promise<void> {
    items.set(key, value)
  },
  async removeItem(key: string): Promise<void> {
    items.delete(key)
  },
}
