import { readBarcodes } from 'zxing-wasm/reader'
import { describe, expect, it } from 'vitest'
import { encodeFrames } from '../framing'
import { MessageKind } from '../types'
import { rasterize } from '../testing/raster'
import { seeded } from '../testing/random'
import { layoutQr } from './layout'
import { qrFrameLimits } from './limits'
import { qrMatrix } from './matrix'
import { qrPath } from './path'
import { frameToText } from './text'

const limits = qrFrameLimits()
const payload = (length: number, seed: number) => {
  const random = seeded(seed)
  return Uint8Array.from({ length }, () => Math.floor(random() * 256))
}
const texts = (length: number) =>
  encodeFrames({ kind: MessageKind.Payment, payload: payload(length, length) }, limits).map(frameToText)

async function decode(matrix: boolean[][], pixelsPerModule: number) {
  const [result] = await readBarcodes(rasterize(matrix, pixelsPerModule), {
    formats: ['QRCode'],
    maxNumberOfSymbols: 1,
  })
  return result?.isValid ? result.text : undefined
}

describe('qrMatrix', () => {
  it.each([
    ['a request with a 48-byte memo', 136, 49],
    ['a first payment', 387, 77],
    ['the largest single frame', 397, 77],
    ['one frame of a 763-byte message', 763, 57],
  ])('draws %s with the modules the plan states (%i bytes, %i modules)', (_, length, modules) => {
    const matrix = qrMatrix(texts(length)[0])
    expect(matrix).toHaveLength(modules)
    expect(matrix.every((row) => row.length === modules)).toBe(true)
  })

  it('draws a 311-character frame in 57 modules or fewer and a 600-character frame in 77 or fewer', () => {
    expect(qrMatrix('A'.repeat(311))).toHaveLength(57)
    expect(qrMatrix('A'.repeat(600))).toHaveLength(77)
  })

  it('is decoded back to the same text by an independent decoder, for the first and the last frame of each message', async () => {
    for (const length of [136, 387, 397, 763, 4147, 8192]) {
      const frames = texts(length)
      for (const text of [frames[0], frames.at(-1)!]) expect(await decode(qrMatrix(text), 6)).toBe(text)
    }
  })

  it('never uses the clock or randomness: the same text gives the same modules', () => {
    const text = texts(387)[0]
    expect(qrMatrix(text)).toEqual(qrMatrix(text))
  })
})

describe('layoutQr', () => {
  it('uses whole pixels per module and the quiet zone of four modules', () => {
    expect(layoutQr(1000, 77)).toEqual({ pixelsPerModule: 11, sizePx: 935, quietPx: 44, crisp: true })
    expect(layoutQr(935, 77).pixelsPerModule).toBe(11)
    expect(layoutQr(934, 77).pixelsPerModule).toBe(10)
  })

  it('reports a code that cannot be drawn with 4 pixels per module as not crisp, and still draws it', () => {
    expect(layoutQr(300, 77)).toMatchObject({ pixelsPerModule: 3, crisp: false })
    expect(layoutQr(10, 77)).toMatchObject({ pixelsPerModule: 1, crisp: false })
  })

  it('draws a 77-module code crisply on a 1080-pixel screen with 24 dp margins at 2.625 density', () => {
    const width = 1080 - 2 * Math.round(24 * 2.625)
    expect(layoutQr(width, 77).crisp).toBe(true)
  })
})

describe('qrPath', () => {
  it('writes a rectangle per run of dark modules', () => {
    expect(
      qrPath([
        [true, true, false],
        [false, true, true],
      ]),
    ).toBe('M0 0h2v1h-2zM1 1h2v1h-2z')
    expect(qrPath([[false]])).toBe('')
  })

  it('describes exactly the dark modules of a real code', () => {
    const matrix = qrMatrix(texts(387)[0])
    const redrawn = matrix.map((row) => row.map(() => false))
    for (const [, x, y, w] of Array.from(qrPath(matrix).matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g), (m) =>
      m.map(Number),
    )) {
      for (let i = 0; i < w; i++) redrawn[y][x + i] = true
    }
    expect(redrawn).toEqual(matrix)
  })
})
