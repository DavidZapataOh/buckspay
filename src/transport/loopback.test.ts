import { expect, it } from 'vitest'
import { describeTransportContract } from './testing/contract'
import { createLoopbackPair } from './testing/loopback'
import { MessageKind } from './types'

describeTransportContract('loopback', createLoopbackPair)

it('does not share the payload buffer with the sender', async () => {
  const [a, b] = createLoopbackPair()
  const payload = Uint8Array.of(1, 2, 3)
  const received = b.receive({ timeoutMs: 1000 })
  await a.send({ kind: MessageKind.Payment, payload })
  payload[0] = 9
  expect((await received).payload[0]).toBe(1)
})
