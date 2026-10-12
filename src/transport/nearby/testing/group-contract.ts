import { describe, expect, it } from 'vitest'
import type { GroupWire } from '../group'

export type GroupRig = {
  hub: GroupWire
  spokes: GroupWire[]
  endpointOf: (spoke: number) => string
  dispose: () => Promise<void>
}

const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 13 + seed) & 0xff)
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

/** Every group wire must pass these, with a hub and `spokes` spokes; member `i` is spoke `i - 1`. */
export function describeGroupWireContract(
  name: string,
  spokes: number,
  makeRig: (spokes: number) => Promise<GroupRig>,
) {
  describe(`group wire contract: ${name} (${spokes} spokes)`, () => {
    const rig = async () => {
      const r = await makeRig(spokes)
      r.spokes.forEach((_, i) => r.hub.identify(r.endpointOf(i), i + 1))
      return r
    }
    const collect = (wire: GroupWire) => {
      const got: { frame: Uint8Array; from: string }[] = []
      wire.onFrame((frame, from) => got.push({ frame, from }))
      return got
    }

    it('delivers_hub_to_one_member_to_that_member_only', async () => {
      const r = await rig()
      const inbox = r.spokes.map(collect)
      await r.hub.send(bytes(100, 1), 1)
      await settle()
      expect(inbox[0]).toHaveLength(1)
      expect(inbox[0][0].frame).toEqual(bytes(100, 1))
      for (const other of inbox.slice(1)) expect(other).toHaveLength(0)
      await r.dispose()
    })

    it('broadcast_reaches_every_identified_member_once', async () => {
      const r = await rig()
      const inbox = r.spokes.map(collect)
      await r.hub.broadcast(bytes(64, 2))
      await settle()
      for (const got of inbox) expect(got.map((g) => g.frame)).toEqual([bytes(64, 2)])
      await r.dispose()
    })

    it('spoke_frame_reaches_the_hub_with_its_endpoint', async () => {
      const r = await rig()
      const got = collect(r.hub)
      await r.spokes[spokes - 1].send(bytes(40, 3))
      await settle()
      expect(got).toEqual([{ frame: bytes(40, 3), from: r.endpointOf(spokes - 1) }])
      await r.dispose()
    })

    it('keeps_frame_order_per_link', async () => {
      const r = await rig()
      const got = collect(r.spokes[0])
      for (let i = 0; i < 50; i++) await r.hub.send(Uint8Array.of(i), 1)
      await settle()
      expect(got.map((g) => g.frame[0])).toEqual(Array.from({ length: 50 }, (_, i) => i))
      await r.dispose()
    })

    it('a_spoke_cannot_reach_another_spoke', async () => {
      if (spokes < 2) return
      const r = await rig()
      const others = r.spokes.slice(1).map(collect)
      await r.spokes[0].send(bytes(30, 4), 2)
      await settle()
      for (const got of others) expect(got).toHaveLength(0)
      await r.dispose()
    })

    it('reports_link_down_when_a_spoke_leaves_and_send_to_it_rejects', async () => {
      const r = await rig()
      const events: string[] = []
      r.hub.onLink((e) => events.push(`${e.type}:${e.endpoint}`))
      await r.spokes[0].close()
      await settle()
      expect(events).toContain(`down:${r.endpointOf(0)}`)
      await expect(r.hub.send(bytes(5, 5), 1)).rejects.toBeInstanceOf(Error)
      await r.dispose()
    })

    it('drop_disconnects_only_that_endpoint', async () => {
      if (spokes < 2) return
      const r = await rig()
      await r.hub.drop(r.endpointOf(0))
      await settle()
      expect(r.hub.spokes()).toBe(spokes - 1)
      const got = collect(r.spokes[1])
      await r.hub.send(bytes(8, 6), 2)
      await settle()
      expect(got).toHaveLength(1)
      await r.dispose()
    })

    it('close_is_idempotent_and_leaves_no_radio_running', async () => {
      const r = await rig()
      await r.hub.close()
      await r.hub.close()
      expect(r.hub.spokes()).toBe(0)
      await r.dispose()
    })
  })
}
