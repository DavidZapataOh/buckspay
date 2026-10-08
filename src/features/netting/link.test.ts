import { describe, expect, it } from 'vitest'
import { describeTransportContract } from '../../transport/testing/contract'
import { MAX_MESSAGE_BYTES, MessageKind, TransportError } from '../../transport/types'
import { LINK_OVERHEAD, relayRoute } from './link'
import { relayNetwork } from './testing/relay'

describeTransportContract('session link (member to member through the host)', () => {
  const net = relayNetwork(3)
  return [net.link(1, 2), net.link(2, 1)]
})
describeTransportContract('session link (member to host)', () => {
  const net = relayNetwork(3)
  return [net.link(1, 0), net.link(0, 1)]
})

const code = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as TransportError).code
const msg = (n: number) => ({ kind: MessageKind.Payment, payload: new Uint8Array(n).fill(7) })

describe('session link', () => {
  it('capacity_is_the_transport_limit_minus_the_relay_overhead', () => {
    const [a] = [relayNetwork(3).link(1, 2)]
    expect(a.capabilities.maxMessageBytes).toBe(MAX_MESSAGE_BYTES - LINK_OVERHEAD)
    expect(a.capabilities.deliveryFeedback).toBe(false)
  })

  it('frames_from_other_members_are_ignored_by_a_link_to_one_peer', async () => {
    const net = relayNetwork(4)
    const toTwo = net.link(1, 2)
    const received = toTwo.receive({ timeoutMs: 80 })
    await net.link(3, 1).send(msg(10))
    expect(await code(received)).toBe('Timeout')
    const again = toTwo.receive({ timeoutMs: 500 })
    await net.link(2, 1).send(msg(11))
    expect((await again).payload).toHaveLength(11)
  })

  it('the_host_sets_from_itself_and_a_member_cannot_spoof_it', async () => {
    expect(relayRoute(1, { to: 2, kind: MessageKind.Payment, payload: Uint8Array.of(1) }, 3)).toMatchObject({
      from: 1,
      to: 2,
    })
    const net = relayNetwork(4)
    const at3 = net.link(3, 1).receive({ timeoutMs: 500 })
    const at2 = net.link(3, 2).receive({ timeoutMs: 60 })
    await net.rawRelay(1, { from: 2, to: 3, kind: MessageKind.Request, payload: Uint8Array.of(9) })
    expect((await at3).payload).toEqual(Uint8Array.of(9))
    expect(await code(at2)).toBe('Timeout')
  })

  it('relay_to_oneself_or_to_a_member_that_does_not_exist_is_dropped', () => {
    expect(relayRoute(2, { to: 2, kind: MessageKind.Payment, payload: new Uint8Array(1) }, 3)).toBeNull()
    expect(relayRoute(2, { to: 3, kind: MessageKind.Payment, payload: new Uint8Array(1) }, 3)).toBeNull()
    expect(relayRoute(2, { to: 0, kind: MessageKind.Payment, payload: new Uint8Array(1) }, 3)).not.toBeNull()
  })

  it('a_message_above_the_link_capacity_is_refused_before_anything_is_sent', async () => {
    const net = relayNetwork(3)
    const link = net.link(1, 2)
    expect(await code(link.send(msg(link.capabilities.maxMessageBytes + 1)))).toBe('TooLarge')
    expect(net.framesSent()).toBe(0)
  })

  it('closing_a_link_leaves_the_wire_and_the_other_links_working', async () => {
    const net = relayNetwork(4)
    const a = net.link(1, 2)
    const b = net.link(1, 3)
    await a.close()
    const got = net.link(3, 1).receive({ timeoutMs: 500 })
    await b.send(msg(5))
    expect((await got).payload).toHaveLength(5)
  })
})
