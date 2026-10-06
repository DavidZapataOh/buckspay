import { QrTransport, type QrSurface, type TextSource } from '../qr/qr-transport'
import { seeded } from './random'

type Camera = { source: TextSource; push(text: string): void }

function createCamera(): Camera {
  const listeners = new Set<(text: string) => void>()
  return {
    source: { subscribe: (listener) => (listeners.add(listener), () => void listeners.delete(listener)) },
    push: (text) => listeners.forEach((listener) => listener(text)),
  }
}

/** A screen whose texts the other phone's camera catches one per tick, missing a seeded share of them. */
function createScreen(camera: Camera, drop: number, random: () => number, everyMs: number): QrSurface {
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => clearInterval(timer)
  return {
    present(texts) {
      stop()
      let next = 0
      timer = setInterval(() => {
        const text = texts[next++ % texts.length]
        if (random() >= drop) camera.push(text)
      }, everyMs)
    },
    clear: stop,
  }
}

/** Two QR transports facing each other through a simulated camera. Tests only. */
export function createQrPair({ drop = 0, seed = 1, everyMs = 1 } = {}): [QrTransport, QrTransport] {
  const random = seeded(seed)
  const [cameraA, cameraB] = [createCamera(), createCamera()]
  return [
    new QrTransport({ surface: createScreen(cameraB, drop, random, everyMs), scanner: cameraA.source }),
    new QrTransport({ surface: createScreen(cameraA, drop, random, everyMs), scanner: cameraB.source }),
  ]
}
