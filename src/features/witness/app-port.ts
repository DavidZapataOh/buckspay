import { CHANNEL_AUDIBLE, CHANNEL_ULTRASOUND } from '../../protocol'
import type { PaymentRequest } from '../../payment/messages'
import type { WitnessSettings } from './policy'
import { createWitnessPort, type WitnessPort, type WitnessStore } from './port'
import { type Clock, DEFAULT_CONFIG, type Modem, type PayerDeps } from './session'

export type Band = 'ultrasound' | 'audible'

/** The band the payer answers on, or null when the receiver did not ask for a check. */
export const payerBand = ({ witness }: Pick<PaymentRequest, 'witness'>): Band | null =>
  witness === 'none' ? null : witness

const CHANNELS = { ultrasound: CHANNEL_ULTRASOUND, audible: CHANNEL_AUDIBLE } as const

const systemClock: Clock = {
  nowSeconds: () => Math.floor(Date.now() / 1000),
  nowMillis: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'))
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        },
        { once: true },
      )
    }),
}

export type AppPortDeps = Pick<PayerDeps, 'sign' | 'witnessDomain'> &
  Partial<Pick<PayerDeps, 'clock' | 'config' | 'random'>> & {
    /** This phone's speaker and microphone on `band`. */
    modem: (band: Band) => Modem
  }

/**
 * The one witness port of the app. Each band has its own session settings (modem and channel) but an attempt is
 * still unique per message: a message is only ever attached on one band.
 */
export function createAppWitnessPort(
  store: WitnessStore,
  settings: () => WitnessSettings,
  { modem, ...deps }: AppPortDeps,
): WitnessPort {
  const ports = new Map<Band, WitnessPort>()
  const portFor = (band: Band) => {
    let port = ports.get(band)
    if (!port) {
      port = createWitnessPort({
        store,
        modem: modem(band),
        channel: CHANNELS[band],
        clock: deps.clock ?? systemClock,
        config: deps.config ?? DEFAULT_CONFIG,
        random: deps.random ?? ((length) => crypto.getRandomValues(new Uint8Array(length))),
        sign: deps.sign,
        witnessDomain: deps.witnessDomain,
      })
      ports.set(band, port)
    }
    return port
  }
  return {
    attach: (messageId, role, band) =>
      portFor(band ?? (settings().audible ? 'audible' : 'ultrasound')).attach(messageId, role),
    cancel(messageId) {
      for (const port of ports.values()) port.cancel(messageId)
    },
  }
}
