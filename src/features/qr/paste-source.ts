import * as Clipboard from 'expo-clipboard'

/** Reads the clipboard once and pushes its text; resolves false when it holds none. */
export async function pasteInto(push: (text: string) => void): Promise<boolean> {
  const text = (await Clipboard.getStringAsync()).trim()
  if (!text) return false
  push(text)
  return true
}
