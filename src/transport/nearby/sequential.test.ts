import { describe, expect, it, vi } from 'vitest'
import type { GroupWire } from './group'
import { joinSequentialHub, SEQUENTIAL_WAIT_MS, startSequentialHub } from './sequential'
import { FakeAir, type FakePhone } from './testing/fake'
import { describeGroupWireContract, type GroupRig } from './testing/group-contract'

const tag = Uint8Array.from({ length: 8 }, (_, i) => i + 9)

async function rig(spokes: number): Promise<GroupRig> {
  const air = new FakeAir()
  const hub = await startSequentialHub(air.phone(), { tag })
  const phones: FakePhone[] = []
  const wires: GroupWire[] = []
  for (let i = 0; i < spokes; i++) {
    const phone = air.phone()
    phones.push(phone)
    wires.push(await joinSequentialHub(phone, { tag }))
  }
  return {
    hub,
    spokes: wires,
    endpointOf: (i) => phones[i].id,
    dispose: async () => {
      await hub.close()
      await Promise.all(wires.map((w) => w.close()))
    },
  }
}

describeGroupWireContract('sequential point-to-point', 1, rig)

describe('sequential wire', () => {
  it('serves_members_in_turn_and_reconnects_the_spoke_that_was_dropped', async () => {
    const air = new FakeAir()
    const hub = await startSequentialHub(air.phone(), { tag })
    const [p1, p2] = [air.phone(), air.phone()]
    const w1 = await joinSequentialHub(p1, { tag })
    hub.identify(p1.id, 1)
    const got1: number[] = []
    w1.onFrame((f) => got1.push(f[0]))
    await hub.send(Uint8Array.of(1), 1)
    const w2 = joinSequentialHub(p2, { tag })
    await hub.drop(p1.id)
    const joined2 = await w2
    hub.identify(p2.id, 2)
    const got2: number[] = []
    joined2.onFrame((f) => got2.push(f[0]))
    await hub.send(Uint8Array.of(2), 2)
    await hub.send(Uint8Array.of(3), 1)
    await new Promise((r) => setTimeout(r, 50))
    expect(got1).toEqual([1, 3])
    expect(got2).toEqual([2])
  })

  it('send_to_a_member_that_never_reconnects_times_out', async () => {
    vi.useFakeTimers()
    try {
      const air = new FakeAir()
      const hub = await startSequentialHub(air.phone(), { tag })
      const p1 = air.phone()
      const w1 = await joinSequentialHub(p1, { tag })
      hub.identify(p1.id, 1)
      await w1.close()
      const outcome = expect(hub.send(Uint8Array.of(1), 1)).rejects.toMatchObject({ reason: 'Timeout' })
      await vi.advanceTimersByTimeAsync(SEQUENTIAL_WAIT_MS + 1)
      await outcome
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses_the_group_service_with_point_to_point', async () => {
    const air = new FakeAir()
    const phone = air.phone()
    await startSequentialHub(phone, { tag })
    expect(phone.advertisingMode).toBe('groupSequential')
  })
})
