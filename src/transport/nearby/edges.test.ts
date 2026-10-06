import { describe, expect, it, vi } from 'vitest'
import { MessageKind, TransportError } from '../types'
import { NearbyFinder, NearbyHost, type PairingOptions, tagFromInfoHex, tagToInfoHex } from './pairing'
import { FakeAir } from './testing/fake'
import { createNearbyTransport } from './transport'
import { NearbyError } from './types'

const options: PairingOptions = {
  random: (n) => crypto.getRandomValues(new Uint8Array(n)),
  confirmTimeoutMs: 80,
  connectTimeoutMs: 80,
}
const tick = () => new Promise((r) => setTimeout(r, 5))

async function meet() {
  const air = new FakeAir()
  const shop = air.phone()
  const buyer = air.phone()
  const host = await NearbyHost.start(shop, options)
  const finder = await NearbyFinder.start(buyer, options)
  await tick()
  return { shop, buyer, host, finder }
}

describe('pairing edges', () => {
  it('accepts a connection once however often the person taps', async () => {
    const { shop, host, finder } = await meet()
    await finder.connect(shop.id)
    await tick()
    await host.confirm()
    await host.confirm()
    expect(shop.calls.filter((c) => c.method === 'acceptConnection')).toHaveLength(1)
  })

  it('turns away a request the payer never made', async () => {
    const { buyer, finder } = await meet()
    buyer.emit({ type: 'initiated', endpointId: 'X', digits: '1234', incoming: true, infoHex: '01' })
    await tick()
    expect(finder.confirming).toBeNull()
    expect(buyer.calls.filter((c) => c.method === 'rejectConnection').map((c) => c.args[0])).toEqual(['X'])
  })

  it('declining with nothing to decline leaves the receiver advertising', async () => {
    const { shop, host } = await meet()
    await host.decline()
    expect(shop.advertising).not.toBeNull()
  })

  it('reads a tag back only when the info has exactly four characters', () => {
    expect(tagFromInfoHex(tagToInfoHex('K7M2') + '41')).toBeNull()
    expect(tagFromInfoHex(tagToInfoHex('K7M2').slice(0, 8))).toBeNull()
  })

  it('leaves no timer behind once connected', async () => {
    vi.useFakeTimers()
    try {
      const air = new FakeAir()
      const shop = air.phone()
      const buyer = air.phone()
      const host = await NearbyHost.start(shop, { ...options, confirmTimeoutMs: 30_000 })
      const finder = await NearbyFinder.start(buyer, { ...options, confirmTimeoutMs: 30_000 })
      await vi.advanceTimersByTimeAsync(5)
      await finder.connect(shop.id)
      await vi.advanceTimersByTimeAsync(5)
      await Promise.all([host.confirm(), finder.confirm()])
      await Promise.all([host.connected, finder.connected])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says Busy when Nearby is already advertising', async () => {
    const phone = new FakeAir().phone()
    phone.failNext = new NearbyError('AlreadyActive')
    await expect(NearbyHost.start(phone, options)).rejects.toMatchObject({ reason: 'Busy' })
  })

  it('ignores what the air says after it stopped', async () => {
    const { shop, finder } = await meet()
    await finder.stop()
    await shop.stopAdvertising()
    await shop.startAdvertising(tagToInfoHex('K7M2'))
    await tick()
    expect(finder.peers.map((p) => p.tag)).not.toContain('K7M2')
  })
})

describe('transport edges', () => {
  const pair = () => {
    const air = new FakeAir()
    const [a, b] = air.connectedPair()
    return {
      a,
      b,
      ta: createNearbyTransport({ endpointId: b.id, native: a }),
      tb: createNearbyTransport({ endpointId: a.id, native: b }),
    }
  }

  it('hands out the first queued message of an accepted kind and drops the ones before it', async () => {
    const { ta, tb } = pair()
    await ta.send({ kind: MessageKind.Request, payload: Uint8Array.of(1) })
    await ta.send({ kind: MessageKind.Receipt, payload: Uint8Array.of(2) })
    await tick()
    expect((await tb.receive({ timeoutMs: 100, accept: [MessageKind.Receipt] })).payload).toEqual(Uint8Array.of(2))
    const left = await tb.receive({ timeoutMs: 30 }).catch((e: TransportError) => e.code)
    expect(left).toBe('Timeout')
  })

  it('does not hang up again on a link that already went', async () => {
    const { a, b, tb } = pair()
    a.drop(b.id)
    await tick()
    await tb.close()
    expect(b.calls.filter((c) => c.method === 'disconnect')).toHaveLength(0)
  })
})
