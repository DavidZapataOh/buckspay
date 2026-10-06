import { describe, expect, it } from 'vitest'
import {
  INFO_VERSION,
  NearbyFinder,
  NearbyHost,
  type PairingError,
  type PairingOptions,
  REQUEST_INFO_HEX,
  TAG_ALPHABET,
  tagFromInfoHex,
  tagToInfoHex,
} from './pairing'
import { nearbyAvailability } from './transport'
import { NearbyError } from './types'
import { FakeAir } from './testing/fake'

const options = (over: Partial<PairingOptions> = {}): PairingOptions => ({
  random: (n) => crypto.getRandomValues(new Uint8Array(n)),
  confirmTimeoutMs: 80,
  connectTimeoutMs: 80,
  ...over,
})
const tick = () => new Promise((r) => setTimeout(r, 5))

async function meet(air = new FakeAir(), opts = options()) {
  const shop = air.phone()
  const buyer = air.phone()
  const host = await NearbyHost.start(shop, opts)
  const finder = await NearbyFinder.start(buyer, opts)
  await tick()
  return { air, shop, buyer, host, finder }
}

describe('what a receiver advertises', () => {
  it('is a version byte and a tag of four characters from an alphabet without look-alikes', async () => {
    const { shop, host } = await meet()
    expect(host.tag).toMatch(new RegExp(`^[${TAG_ALPHABET}]{4}$`))
    expect(TAG_ALPHABET).not.toMatch(/[IO01]/)
    expect(shop.advertising).toBe(tagToInfoHex(host.tag))
    expect(shop.advertising).toHaveLength(10)
    expect(shop.advertising!.slice(0, 2)).toBe('0' + INFO_VERSION)
  })

  it('is a new tag every time, so two sessions cannot be linked', async () => {
    const tags = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const { host } = await meet()
      tags.add(host.tag)
    }
    expect(tags.size).toBeGreaterThan(15)
  })

  it('never contains anything but the tag: no key, amount, name or address', async () => {
    const { shop } = await meet()
    expect(shop.calls.filter((c) => c.method === 'startAdvertising').map((c) => (c.args[0] as string).length)).toEqual([
      10,
    ])
  })

  it('is read back only from info that is ours', () => {
    expect(tagFromInfoHex(tagToInfoHex('K7M2'))).toBe('K7M2')
    for (const bad of [
      '',
      '01',
      '0100000000',
      tagToInfoHex('K7M2').slice(2),
      '02' + tagToInfoHex('K7M2').slice(2),
      'zz',
      tagToInfoHex('k7m2'),
      tagToInfoHex('K7M0'),
    ]) {
      expect(tagFromInfoHex(bad)).toBeNull()
    }
  })
})

describe('finding a receiver', () => {
  it('lists the receivers nearby by tag, and drops one that stops advertising', async () => {
    const { shop, host, finder } = await meet()
    expect(finder.peers).toEqual([{ endpointId: shop.id, tag: host.tag }])
    await shop.stopAdvertising()
    await tick()
    expect(finder.peers).toEqual([])
  })

  it('ignores an advertiser that is not Buckspay', async () => {
    const air = new FakeAir()
    const stranger = air.phone()
    const buyer = air.phone()
    await stranger.startAdvertising('ff00112233')
    const finder = await NearbyFinder.start(buyer, options())
    await tick()
    expect(finder.peers).toEqual([])
  })

  it('asks to connect with an info that names nobody', async () => {
    const { buyer, shop, finder } = await meet()
    await finder.connect(shop.id)
    expect(buyer.calls.find((c) => c.method === 'requestConnection')!.args).toEqual([shop.id, REQUEST_INFO_HEX])
    expect(REQUEST_INFO_HEX).toBe('01')
    expect(buyer.discovering).toBe(false)
  })

  it('refuses to connect to something it did not list, and to ask twice', async () => {
    const { shop, finder } = await meet()
    await expect(finder.connect('nobody')).rejects.toMatchObject({ reason: 'Busy' })
    await finder.connect(shop.id)
    await expect(finder.connect(shop.id)).rejects.toMatchObject({ reason: 'Busy' })
  })
})

describe('connecting', () => {
  it('shows the same four digits on both phones and connects only after both confirm', async () => {
    const { shop, buyer, host, finder } = await meet()
    await finder.connect(shop.id)
    await tick()
    expect(host.confirming!.digits).toMatch(/^\d{4}$/)
    expect(finder.confirming!.digits).toBe(host.confirming!.digits)
    let settled = false
    void Promise.all([host.connected, finder.connected]).then(() => (settled = true))
    await finder.confirm()
    await tick()
    expect(settled).toBe(false)
    await host.confirm()
    const [hostLink, finderLink] = await Promise.all([host.connected, finder.connected])
    expect(hostLink.endpointId).toBe(buyer.id)
    expect(finderLink.endpointId).toBe(shop.id)
  })

  it('stops advertising and discovering once connected, so nobody else can join', async () => {
    const { shop, buyer, host, finder } = await meet()
    await finder.connect(shop.id)
    await tick()
    await Promise.all([finder.confirm(), host.confirm()])
    await Promise.all([host.connected, finder.connected])
    await tick()
    expect(shop.advertising).toBeNull()
    expect(buyer.discovering).toBe(false)
  })

  it('ends with Rejected on the other side when one person declines', async () => {
    const { shop, host, finder } = await meet()
    await finder.connect(shop.id)
    await tick()
    await host.decline()
    await expect(host.connected).rejects.toMatchObject({ reason: 'Declined' })
    await expect(finder.connected).rejects.toMatchObject({ reason: 'Rejected' })
    expect(host.confirming).toBeNull()
  })

  it('shows one request at a time and turns every other one away at once', async () => {
    const air = new FakeAir()
    const shop = air.phone()
    const first = air.phone()
    const second = air.phone()
    const host = await NearbyHost.start(shop, options())
    const a = await NearbyFinder.start(first, options())
    const b = await NearbyFinder.start(second, options())
    await tick()
    await a.connect(shop.id)
    await tick()
    await b.connect(shop.id)
    await tick()
    expect(host.confirming!.endpointId).toBe(first.id)
    await expect(b.connected).rejects.toMatchObject({ reason: 'Rejected' })
    expect(shop.calls.filter((c) => c.method === 'rejectConnection').map((c) => c.args[0])).toEqual([second.id])
  })

  it('gives a person only so long to compare the code', async () => {
    const air = new FakeAir()
    const shop = air.phone()
    const buyer = air.phone()
    const host = await NearbyHost.start(shop, options({ confirmTimeoutMs: 30 }))
    const finder = await NearbyFinder.start(buyer, options({ confirmTimeoutMs: 500 }))
    await tick()
    await finder.connect(shop.id)
    await expect(host.connected).rejects.toMatchObject({ reason: 'Timeout' })
    await expect(finder.connected).rejects.toMatchObject({ reason: 'Rejected' })
  })

  it('gives a request only so long to be answered', async () => {
    const air = new FakeAir()
    const shop = air.phone()
    const buyer = air.phone()
    await NearbyHost.start(shop, options())
    const finder = await NearbyFinder.start(buyer, options({ connectTimeoutMs: 30 }))
    await tick()
    buyer.emit = () => {}
    await finder.connect(shop.id)
    await expect(finder.connected).rejects.toMatchObject({ reason: 'Timeout' })
  })

  it('leaves nothing running when stopped before anyone connects', async () => {
    const { shop, buyer, host, finder } = await meet()
    await host.stop()
    await finder.stop()
    expect(shop.advertising).toBeNull()
    expect(buyer.discovering).toBe(false)
    await expect(host.connected).rejects.toBeDefined()
  })
})

describe('when Nearby cannot start', () => {
  const cases: [NearbyError['code'], PairingError['reason']][] = [
    ['RadioOff', 'RadioOff'],
    ['PermissionMissing', 'Permission'],
    ['Unsupported', 'Unsupported'],
    ['Failed', 'Error'],
  ]
  it.each(cases)('%s while advertising is %s', async (code, reason) => {
    const phone = new FakeAir().phone()
    phone.failNext = new NearbyError(code)
    await expect(NearbyHost.start(phone, options())).rejects.toMatchObject({ reason })
  })

  it.each(cases)('%s while discovering is %s', async (code, reason) => {
    const phone = new FakeAir().phone()
    phone.failNext = new NearbyError(code)
    await expect(NearbyFinder.start(phone, options())).rejects.toMatchObject({ reason })
  })

  it('says why in check(): no Play services, missing permission, Bluetooth off, or ready', () => {
    expect(nearbyAvailability({ playServices: false, permissions: true, bluetooth: true })).toEqual({
      ready: false,
      reason: 'unsupported',
    })
    expect(nearbyAvailability({ playServices: true, permissions: false, bluetooth: true })).toEqual({
      ready: false,
      reason: 'permission-denied',
    })
    expect(nearbyAvailability({ playServices: true, permissions: true, bluetooth: false })).toEqual({
      ready: false,
      reason: 'disabled',
    })
    expect(nearbyAvailability({ playServices: true, permissions: true, bluetooth: true })).toEqual({ ready: true })
  })
})
