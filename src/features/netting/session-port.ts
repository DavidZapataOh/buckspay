import type { GroupWire } from '../../transport/nearby/group'
import type { MessageKind } from '../../transport/types'
import { type SessionChannel } from './channel'
import { type LinkPort, relayRoute } from './link'
import type { Inbox } from './session-io'
import { sealMessage } from './session-io'

/** The link a session leaves behind: frames between phones, relayed through the host, and the way to let it go. */
export type SessionPort = LinkPort & { close(): void }

const FOREVER = 2 ** 31 - 1

/**
 * Turns the wire of a finished session into a `LinkPort`. A member sends a `Relay` to the host; the host sends
 * its own to a member and forwards a member's to the member it names, by the index it identified the frame's
 * endpoint with and never by the frame's own field.
 */
export function sessionPort(input: {
  wire: GroupWire
  channel: SessionChannel
  inbox: Inbox
  me: number
}): SessionPort {
  const { wire, channel, inbox, me } = input
  const hub = wire.role === 'hub'
  const listeners = new Set<(from: number, kind: MessageKind, payload: Uint8Array) => void>()
  const stop = new AbortController()

  const deliver = (from: number, kind: MessageKind, payload: Uint8Array) =>
    listeners.forEach((listener) => listener(from, kind, payload))
  const toMember = async (to: number, from: number, kind: MessageKind, payload: Uint8Array) =>
    wire.send(await sealMessage(channel, { type: 'Relay', from, to, kind, payload }), to).catch(() => undefined)

  void (async () => {
    for (;;) {
      const got = await inbox.take((m) => m.message.type === 'Relay', FOREVER, stop.signal)
      if (got === 'aborted') return
      if (typeof got === 'string' || 'gone' in got || got.message.type !== 'Relay') continue
      const relay = got.message
      if (!hub) {
        deliver(relay.from, relay.kind, relay.payload)
        continue
      }
      const routed = relayRoute(got.sender, relay, wire.spokes() + 1)
      if (!routed) continue
      if (routed.to === me) deliver(routed.from, routed.kind, routed.payload)
      else await toMember(routed.to, routed.from, routed.kind, routed.payload)
    }
  })()

  return {
    me,
    async send(to, kind, payload) {
      const frame = await sealMessage(channel, { type: 'Relay', from: me, to, kind, payload })
      await (hub ? wire.send(frame, to) : wire.send(frame))
    },
    onRelay(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    close() {
      stop.abort()
      inbox.close()
    },
  }
}
