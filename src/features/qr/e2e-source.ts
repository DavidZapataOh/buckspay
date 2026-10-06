import { addEventListener } from 'expo-linking'

/**
 * End-to-end builds only: listens for `buckspay-e2e://scan?text=<encodeURIComponent(text)>` and pushes
 * the text. Outside them (`EXPO_PUBLIC_E2E` is not `1`) it does nothing, and the bundler removes the body.
 */
export function installE2eScan(push: (text: string) => void): () => void {
  if (process.env.EXPO_PUBLIC_E2E !== '1') return () => {}
  const subscription = addEventListener('url', ({ url }) => {
    const match = /^buckspay-e2e:\/\/scan\?text=(.*)$/.exec(url)
    if (match) push(decodeURIComponent(match[1]))
  })
  return () => subscription.remove()
}
