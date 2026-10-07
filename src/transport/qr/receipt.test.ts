import { readBarcodes } from 'zxing-wasm/reader'
import { describe, expect, it } from 'vitest'
import { decodeReceipt, encodeReceipt } from '../../payment/messages'
import { Reason } from '../../payment/reasons'
import { encodeFrames, Reassembler } from '../framing'
import { rasterize } from '../testing/raster'
import { MessageKind } from '../types'
import { qrFrameLimits } from './limits'
import { qrMatrix } from './matrix'
import { frameToText, textToFrame } from './text'

describe('the receipt the receiver shows', () => {
  const receipt = encodeReceipt({ accepted: true, reason: Reason.Accepted, messageId: new Uint8Array(32).fill(9) })
  const texts = encodeFrames({ kind: MessageKind.Receipt, payload: receipt }, qrFrameLimits()).map(frameToText)

  it('is one small code, read back by an independent decoder at every module size, and decodes to the receipt', async () => {
    expect(texts).toHaveLength(1)
    const matrix = qrMatrix(texts[0])
    console.log('receipt modules', matrix.length, 'chars', texts[0].length)
    for (const pixels of [2, 4, 8, 16, 32]) {
      const [result] = await readBarcodes(rasterize(matrix, pixels), { formats: ['QRCode'], maxNumberOfSymbols: 1 })
      expect(result?.text).toBe(texts[0])
    }
    const frame = textToFrame(texts[0])!
    const done = new Reassembler().push(frame)
    expect(done.status).toBe('complete')
    if (done.status === 'complete') expect(decodeReceipt(done.message.payload).accepted).toBe(true)
  })
})
