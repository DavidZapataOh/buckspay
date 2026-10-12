export const RATE = 22050

export type Note = { hz: number; ms: number }
export type Tone = { wave: 'sine' | 'triangle'; peak: number; notes: readonly Note[] }

const ATTACK_MS = 5
const RELEASE_MS = 25

const wave = {
  sine: (cycle: number) => Math.sin(2 * Math.PI * cycle),
  triangle: (cycle: number) => 4 * Math.abs(cycle - Math.floor(cycle + 0.5)) - 1,
}

/** One note per entry, each fading in and out so that nothing clicks. */
export function renderTone({ wave: shape, peak, notes }: Tone): Int16Array {
  const attack = Math.round((RATE * ATTACK_MS) / 1000)
  const release = Math.round((RATE * RELEASE_MS) / 1000)
  const lengths = notes.map(({ ms }) => Math.round((RATE * ms) / 1000))
  const pcm = new Int16Array(lengths.reduce((sum, length) => sum + length, 0))
  let at = 0
  notes.forEach(({ hz }, index) => {
    const length = lengths[index]
    for (let i = 0; i < length; i++) {
      const envelope = Math.exp((-3 * i) / length) * Math.min(1, i / attack) * Math.min(1, (length - 1 - i) / release)
      pcm[at + i] = Math.round(wave[shape]((hz * i) / RATE) * envelope * peak * 32767)
    }
    at += length
  })
  return pcm
}

/** A 16-bit mono PCM wav file. */
export function wavFile(pcm: Int16Array, rate = RATE): Uint8Array {
  const file = new Uint8Array(44 + pcm.length * 2)
  const view = new DataView(file.buffer)
  const text = (at: number, value: string) => [...value].forEach((char, i) => (file[at + i] = char.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, file.length - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  pcm.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true))
  return file
}

/** A tap is a tick, a step a rising pair, a success a bright arpeggio, a problem a soft fall. */
export const TONES = {
  tap: { wave: 'sine', peak: 0.35, notes: [{ hz: 1200, ms: 35 }] },
  step: {
    wave: 'sine',
    peak: 0.4,
    notes: [
      { hz: 660, ms: 70 },
      { hz: 880, ms: 110 },
    ],
  },
  success: {
    wave: 'sine',
    peak: 0.5,
    notes: [
      { hz: 523.25, ms: 90 },
      { hz: 659.25, ms: 90 },
      { hz: 783.99, ms: 90 },
      { hz: 1046.5, ms: 260 },
    ],
  },
  problem: {
    wave: 'triangle',
    peak: 0.45,
    notes: [
      { hz: 392, ms: 110 },
      { hz: 261.6, ms: 200 },
    ],
  },
} as const satisfies Record<string, Tone>
