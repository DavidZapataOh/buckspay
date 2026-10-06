import Nfc, { type NfcLinkStats, type NfcProgressEvent } from '../../../modules/nfc/src/NfcModule'
import { type NfcErrorCode, type NfcNative, NfcNativeError } from './types'

const CODES: readonly string[] = ['Cancelled', 'Interrupted', 'Malformed', 'Busy', 'Unavailable']

async function call<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    throw new NfcNativeError((CODES.includes(code) ? code : 'Unavailable') as NfcErrorCode)
  }
}

/** The only place that touches the native module. `instance` 0 is the radio. */
export const createNfcNative = (instance = 0): NfcNative => ({
  support: () => call(Nfc.support(instance)),
  acquire: (role) => call(Nfc.acquire(role, instance)),
  release: () => call(Nfc.release(instance)),
  offer: (opId, kind, payload) => call(Nfc.offer(opId, kind, payload, instance)),
  push: (opId, kind, payload) => call(Nfc.push(opId, kind, payload, instance)),
  receive: (opId, acceptMask) => call(Nfc.receive(opId, acceptMask, instance)),
  cancel: (opId) => Nfc.cancel(opId, instance),
  addProgressListener: (listener) => {
    const subscription = Nfc.addListener('onProgress', (event: NfcProgressEvent) =>
      listener({ ...event, linkMs: event.linkMs ?? undefined }),
    )
    return () => subscription.remove()
  },
})

export const nfcNative = createNfcNative()

/** Lengths and times of the last links, for the measurement screen; never payload. */
export const nfcLinkStats = (): NfcLinkStats[] => Nfc.stats()
