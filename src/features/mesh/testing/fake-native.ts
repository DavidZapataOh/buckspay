import type { MeshNative, MeshStartError } from '../native'

/** An in-memory `MeshNative` for tests of the screens and hooks; the real one is the Kotlin module. */
export function fakeMeshNative(options: { startError?: MeshStartError } = {}): MeshNative & { running(): boolean } {
  let enabled = false
  let running = false
  let paused = false
  return {
    running: () => running,
    support: async () => ({ ble: true, extended: true, maxAdvertisingBytes: 251, gattServer: true }),
    async start() {
      if (options.startError) throw Object.assign(new Error(options.startError), { code: options.startError })
      enabled = true
      running = true
    },
    async stop() {
      enabled = false
      running = false
    },
    pause: async () => {
      paused = true
    },
    resume: async () => {
      paused = false
    },
    advertise: async () => {},
    withdraw: async () => {},
    status: async () => ({ enabled, running, paused, scanStartsLast30s: 0, frames: 0 }),
  }
}
