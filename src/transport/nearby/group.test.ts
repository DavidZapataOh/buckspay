import { describe, expect, it } from 'vitest'
import type { GroupWire } from './group'
import { createNearbyTransport } from './transport'
import { GROUP_INFO_VERSION, GroupError, groupInfoHex, joinHub, MAX_SPOKES, startHub } from './group'
import { NearbyHost, NearbyFinder, DEFAULT_PAIRING } from './pairing'
import { FakeAir, type FakePhone } from './testing/fake'
import { describeGroupWireContract, type GroupRig } from './testing/group-contract'

const tag = Uint8Array.from({ length: 8 }, (_, i) => i + 1)
const otherTag = Uint8Array.from({ length: 8 }, (_, i) => 100 + i)

async function rig(spokes: number): Promise<GroupRig> {
  const air = new FakeAir()
  const hubPhone = air.phone()
  const hub = await startHub(hubPhone, { tag })
  const phones: FakePhone[] = []
  const wires: GroupWire[] = []
  for (let i = 0; i < spokes; i++) {
    const phone = air.phone()
    phones.push(phone)
    wires.push(await joinHub(phone, { tag }))
  }
  return {
    hub,
    spokes: wires,
    endpointOf: (i) => phones[i].id,
    dispose: async () => {
      await Promise.all(wires.map((w) => w.close()))
      await hub.close()
    },
  }
}

for (const spokes of [1, 3, 7]) describeGroupWireContract('P2P_STAR', spokes, rig)

describe('group wire over the fake air', () => {
  it('hub_advertises_the_group_service_with_the_group_strategy_and_info', async () => {
    const air = new FakeAir()
    const phone = air.phone()
    await startHub(phone, { tag })
    expect(phone.advertisingMode).toBe('group')
    expect(phone.advertising).toBe(groupInfoHex(tag))
    expect(groupInfoHex(tag)).toBe(`0${GROUP_INFO_VERSION}${Buffer.from(tag).toString('hex')}`)
    expect(phone.calls.find((c) => c.method === 'startAdvertising')?.args).toEqual([groupInfoHex(tag), 'group'])
  })

  it('hub_accepts_the_matching_tag_and_rejects_a_connection_with_another', async () => {
    const air = new FakeAir()
    const hubPhone = air.phone()
    const hub = await startHub(hubPhone, { tag })
    const intruder = air.phone()
    await intruder.startDiscovery('group')
    await intruder.requestConnection(hubPhone.id, groupInfoHex(otherTag))
    await new Promise((r) => setTimeout(r, 20))
    expect(hub.spokes()).toBe(0)
    expect(hubPhone.calls.some((c) => c.method === 'rejectConnection' && c.args[0] === intruder.id)).toBe(true)
    await joinHub(air.phone(), { tag })
    expect(hub.spokes()).toBe(1)
  })

  it('hub_refuses_the_eighth_spoke', async () => {
    const air = new FakeAir()
    const hub = await startHub(air.phone(), { tag })
    for (let i = 0; i < MAX_SPOKES; i++) await joinHub(air.phone(), { tag })
    await expect(joinHub(air.phone(), { tag, timeoutMs: 100 })).rejects.toBeInstanceOf(GroupError)
    expect(hub.spokes()).toBe(MAX_SPOKES)
  })

  it('spoke_ignores_other_hubs_and_connects_to_its_own', async () => {
    const air = new FakeAir()
    const [a, b] = [air.phone(), air.phone()]
    await startHub(a, { tag: otherTag })
    const hub = await startHub(b, { tag })
    await joinHub(air.phone(), { tag })
    expect(hub.spokes()).toBe(1)
  })

  it('spoke_times_out_when_no_hub_is_found', async () => {
    const air = new FakeAir()
    await expect(joinHub(air.phone(), { tag, timeoutMs: 30 })).rejects.toMatchObject({ reason: 'Timeout' })
  })

  it('spoke_stops_discovery_on_abort_and_on_timeout', async () => {
    const air = new FakeAir()
    const phone = air.phone()
    const controller = new AbortController()
    const joining = joinHub(phone, { tag, signal: controller.signal })
    controller.abort()
    await expect(joining).rejects.toMatchObject({ reason: 'Error' })
    expect(phone.discovering).toBe(false)
  })

  it('native_errors_map_to_group_failures', async () => {
    const air = new FakeAir()
    const phone = air.phone()
    const { NearbyError } = await import('./types')
    phone.failNext = new NearbyError('RadioOff')
    await expect(startHub(phone, { tag })).rejects.toMatchObject({ reason: 'RadioOff' })
    phone.failNext = new NearbyError('PermissionMissing')
    await expect(joinHub(phone, { tag })).rejects.toMatchObject({ reason: 'Permission' })
  })

  it('group_mode_does_not_advertise_the_pay_service', async () => {
    const air = new FakeAir()
    await startHub(air.phone(), { tag })
    const payer = air.phone()
    const finder = await NearbyFinder.start(payer, { ...DEFAULT_PAIRING, random: () => new Uint8Array(4) })
    await new Promise((r) => setTimeout(r, 10))
    expect(finder.peers).toEqual([])
  })

  it('pay_and_group_cannot_run_together_on_one_phone', async () => {
    const air = new FakeAir()
    const phone = air.phone()
    await startHub(phone, { tag })
    await expect(
      NearbyHost.start(phone, { ...DEFAULT_PAIRING, random: () => new Uint8Array(4) }),
    ).rejects.toMatchObject({ reason: 'Busy' })
  })

  it('pay_sessions_still_use_point_to_point_and_the_pay_service', async () => {
    const air = new FakeAir()
    const phone = air.phone()
    await NearbyHost.start(phone, { ...DEFAULT_PAIRING, random: () => Uint8Array.of(1, 2, 3, 4) })
    expect(phone.advertisingMode).toBe('pay')
    expect(phone.calls.find((c) => c.method === 'startAdvertising')?.args).toHaveLength(1)
    const [a, b] = air.connectedPair()
    const transport = createNearbyTransport({ endpointId: b.id, native: a, role: 'receiver' })
    expect(transport.id).toBe('nearby')
  })

  it('a_pay_phone_cannot_hold_two_connections_but_a_star_hub_can', async () => {
    const air = new FakeAir()
    const [a, b, c] = [air.phone(), air.phone(), air.phone()]
    await a.startAdvertising('01', 'pay')
    await b.startDiscovery('pay')
    await c.startDiscovery('pay')
    await b.requestConnection(a.id, '01')
    await a.acceptConnection(b.id)
    await b.acceptConnection(a.id)
    await expect(c.requestConnection(a.id, '01')).rejects.toMatchObject({ code: 'Failed' })
  })

  it('a_hub_that_cannot_hold_more_spokes_reports_a_failure_not_a_hang', async () => {
    const air = new FakeAir()
    air.starLimit = 2
    await startHub(air.phone(), { tag })
    await joinHub(air.phone(), { tag })
    await joinHub(air.phone(), { tag })
    await expect(joinHub(air.phone(), { tag, timeoutMs: 100 })).rejects.toBeInstanceOf(GroupError)
  })
})
