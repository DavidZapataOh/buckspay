import Copresence, { type Band } from '../../../modules/copresence/src/CopresenceModule'
import type { Modem } from './session'

/** Asks for the microphone permission; resolves true when it is granted. */
export const requestMicrophone = () => Copresence.requestPermission()

/** This phone's speaker and microphone as a `Modem`, on one band. */
export function createModem(band: Band = 'ultrasound'): Modem {
  let operations = 0
  return {
    async check() {
      const state = await Copresence.check()
      return state.ready ? { ready: true } : { ready: false, reason: state.reason ?? 'unsupported' }
    },
    async emit(payload, options) {
      const signal = options?.signal
      if (signal?.aborted) return
      const opId = operations++
      const cancel = () => Copresence.cancel(opId)
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        await Copresence.play(opId, payload, band)
      } finally {
        signal?.removeEventListener('abort', cancel)
      }
    },
    async listen(onMessage) {
      const subscription = Copresence.addListener('onMessage', () => {
        for (let payload = Copresence.take(); payload; payload = Copresence.take()) onMessage(payload)
      })
      try {
        await Copresence.start(band)
      } catch (error) {
        subscription.remove()
        throw error
      }
      return async () => {
        subscription.remove()
        await Copresence.stop()
      }
    },
  }
}
