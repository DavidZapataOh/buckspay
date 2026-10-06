import { TransportBase } from '../base'
import { encodeFrames, Reassembler } from '../framing'
import {
  type Availability,
  MAX_MESSAGE_BYTES,
  type Message,
  type ReceiveOptions,
  type SendOptions,
  type Transport,
  TransportError,
} from '../types'
import { qrFrameLimits } from './limits'
import { frameToText, textToFrame } from './text'

/** Where the texts of a message are shown; the component behind it cycles them at a fixed rate. */
export type QrSurface = { present(texts: readonly string[]): void; clear(): void }

/** Where scanned texts come from: the camera, pasted text, or an end-to-end test harness. */
export type TextSource = { subscribe(listener: (text: string) => void): () => void }

export class QrTransport extends TransportBase implements Transport {
  readonly id = 'qr'
  readonly capabilities = { maxMessageBytes: MAX_MESSAGE_BYTES, deliveryFeedback: false } as const

  constructor(
    private readonly deps: {
      surface: QrSurface
      scanner: TextSource
      /** Camera permission and hardware; defaults to ready. */
      availability?: () => Promise<Availability>
      /** Overrides QR_CHARS. */
      chars?: { single: number; multi: number }
    },
  ) {
    super()
  }

  check(): Promise<Availability> {
    return this.deps.availability?.() ?? Promise.resolve({ ready: true })
  }

  async send(message: Message, options?: SendOptions) {
    this.assertOpen(options?.signal)
    if (message.payload.length > this.capabilities.maxMessageBytes) throw new TransportError('TooLarge')
    const texts = encodeFrames(message, qrFrameLimits(this.deps.chars)).map(frameToText)
    this.deps.surface.present(texts)
    this.setShown(true)
    this.emit({
      type: 'progress',
      direction: 'out',
      kind: message.kind,
      unit: 'frames',
      done: texts.length,
      total: texts.length,
    })
  }

  receive(options?: ReceiveOptions) {
    return this.receiveWith(options, (deliver) => {
      const reassembler = new Reassembler()
      let total = 1
      return this.deps.scanner.subscribe((text) => {
        const frame = textToFrame(text)
        if (!frame) return
        const result = reassembler.push(frame)
        if (result.status === 'progress') {
          total = result.total
          if (!result.duplicate) {
            this.emit({
              type: 'progress',
              direction: 'in',
              kind: result.kind,
              unit: 'frames',
              done: result.received,
              total,
            })
          }
        } else if (result.status === 'complete') {
          this.emit({
            type: 'progress',
            direction: 'in',
            kind: result.message.kind,
            unit: 'frames',
            done: total,
            total,
          })
          deliver(result.message)
        }
      })
    })
  }

  protected release() {
    this.deps.surface.clear()
  }
}
