import { describe, expect, it } from 'vitest'
import { createLoopbackPair } from '../../transport/testing/loopback'
import type { Message, SendOptions, Transport } from '../../transport/types'
import { trial } from './lab-trial'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The in-memory link hands a message only to a phone that is already waiting; this one waits a moment before sending, so the other is listening. */
const patient = (transport: Transport): Transport =>
  new Proxy(transport, {
    get(target, property) {
      if (property === 'send') {
        return async (message: Message, options?: SendOptions) => {
          await delay(5)
          await target.send(message, options)
        }
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

/** The finder is already listening when the host sends. */
async function exchange(size: number, hostTrial: number, findTrial: number) {
  const [a, b] = createLoopbackPair()
  const host = patient(a)
  const find = patient(b)
  const finder = trial(find, 'find', size, findTrial)
  await delay(5)
  const hosted = trial(host, 'host', size, hostTrial)
  const results = await Promise.all([hosted, finder])
  await Promise.all([a.close(), b.close()])
  return results
}

describe('a lab trial between two phones', () => {
  for (const size of [387, 1136, 4144, 8192]) {
    it(`moves ${size} bytes each way and compares them`, async () => {
      const [host, find] = await exchange(size, 3, 3)
      expect(host).toMatchObject({ role: 'host', size, trial: 3, ok: true, result: 'ok' })
      expect(find).toMatchObject({ role: 'find', size, trial: 3, ok: true, result: 'ok' })
      expect(host.ms).toBeGreaterThanOrEqual(host.sendMs)
    })
  }

  it('reports a trial that gets no answer as failed, with the reason', async () => {
    const [a, b] = createLoopbackPair()
    const host = await trial(a, 'host', 387, 0, 50)
    expect(host.ok).toBe(false)
    expect(host.result).toContain('Timeout')
    await Promise.all([a.close(), b.close()])
  })

  it('does not take a message of another trial for its own', async () => {
    const [host, find] = await exchange(387, 1, 2)
    expect(host.ok).toBe(false)
    expect(find.ok).toBe(false)
  })
})
