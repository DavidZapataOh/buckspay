import { describe, expect, it } from 'vitest'
import { RATE, renderTone, TONES, wavFile } from './synth'

const peak = (pcm: Int16Array) => Math.max(...Array.from(pcm, Math.abs)) / 32767
const hertz = (pcm: Int16Array) => {
  let crossings = 0
  for (let i = 1; i < pcm.length; i++) if (pcm[i - 1] < 0 !== pcm[i] < 0) crossings++
  return crossings / 2 / (pcm.length / RATE)
}

describe('the tones the app answers with', () => {
  it.each(Object.entries(TONES))('%s is quiet enough, starts and ends at silence', (_name, tone) => {
    const pcm = renderTone(tone)
    expect(peak(pcm)).toBeGreaterThan(0.2)
    expect(peak(pcm)).toBeLessThanOrEqual(tone.peak)
    expect(Math.abs(pcm[0])).toBeLessThan(400)
    expect(Math.abs(pcm[pcm.length - 1])).toBeLessThan(400)
  })

  it('plays the note it was asked for', () => {
    const pcm = renderTone({ wave: 'sine', peak: 0.4, notes: [{ hz: 880, ms: 200 }] })
    expect(hertz(pcm)).toBeGreaterThan(880 * 0.95)
    expect(hertz(pcm)).toBeLessThan(880 * 1.05)
    expect(pcm.length).toBe(Math.round((RATE * 200) / 1000))
  })

  it('keeps taps short and the success the longest, with the problem lower than the success', () => {
    const length = (name: keyof typeof TONES) => renderTone(TONES[name]).length
    expect(length('tap')).toBeLessThan(length('step'))
    expect(length('success')).toBeGreaterThan(length('step'))
    expect(length('success')).toBeGreaterThan(length('problem'))
    expect(hertz(renderTone(TONES.problem))).toBeLessThan(hertz(renderTone(TONES.success)))
  })
})

describe('the wav file', () => {
  const pcm = Int16Array.of(0, 1000, -1000, 0)
  const file = wavFile(pcm)
  const view = new DataView(file.buffer)
  const text = (at: number) => String.fromCharCode(...file.slice(at, at + 4))

  it('has the header of 16-bit mono PCM at the rate of the tones', () => {
    expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data'])
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(RATE)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(8)
    expect(view.getUint32(4, true)).toBe(file.length - 8)
    expect(view.getInt16(46, true)).toBe(1000)
  })
})
