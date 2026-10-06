import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'
import { isRecordable, outputId, ProtocolError } from '../protocol'
import { SALT_TRIES, withRecordableOutputs } from './salt'

const unrecordable = () => new ProtocolError('Unrecordable')

describe('withRecordableOutputs', () => {
  it('returns the first candidate that passes and draws no salt for it', () => {
    let draws = 0
    const first = { salt: new Uint8Array(16) }
    const result = withRecordableOutputs(
      first,
      (salt) => ({ salt }),
      () => {},
      () => (draws++, new Uint8Array(16)),
    )
    expect(result).toBe(first)
    expect(draws).toBe(0)
  })

  it('draws a fresh salt for every attempt and gives up with a typed error after SALT_TRIES', () => {
    const seen: number[] = []
    let counter = 0
    const draw = () => new Uint8Array(16).fill(++counter % 256)
    const attempt = () =>
      withRecordableOutputs(
        { salt: new Uint8Array(16) },
        (salt) => ({ salt }),
        (candidate) => {
          seen.push(candidate.salt[0])
          throw unrecordable()
        },
        draw,
      )
    expect(attempt).toThrow(expect.objectContaining({ code: 'Unrecordable' }))
    expect(seen).toHaveLength(SALT_TRIES)
    expect(counter).toBe(SALT_TRIES)
  })

  it('succeeds on the last attempt and hears any other refusal at once', () => {
    let calls = 0
    const last = withRecordableOutputs(
      0,
      (salt) => salt[0],
      () => {
        if (++calls < SALT_TRIES) throw unrecordable()
      },
      () => new Uint8Array(16),
    )
    expect(calls).toBe(SALT_TRIES)
    expect(last).toBe(0)
    expect(() =>
      withRecordableOutputs(
        0,
        () => 0,
        () => {
          throw new ProtocolError('Signer')
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'Signer' }))
  })

  it('never runs out of draws for a message with two outputs', () => {
    const program = new Uint8Array(32).fill(3)
    let seed = 1
    const draw = () => {
      const salt = new Uint8Array(16)
      new DataView(salt.buffer).setUint32(0, seed++)
      return salt
    }
    let worst = 0
    for (let run = 0; run < 1_000; run++) {
      let tries = 0
      withRecordableOutputs(
        draw(),
        (salt) => salt,
        (salt) => {
          tries++
          const id = sha256(salt)
          for (const index of [0, 1]) if (!isRecordable(program, outputId(id, index))) throw unrecordable()
        },
        draw,
      )
      worst = Math.max(worst, tries)
    }
    expect(worst).toBeLessThanOrEqual(SALT_TRIES)
  }, 60_000)
})
