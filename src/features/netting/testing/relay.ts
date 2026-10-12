import { type MessageKind, TransportError } from '../../../transport/types'
import { type LinkPort, relayRoute, SessionLink } from '../link'

type Relay = { from: number; to: number; kind: MessageKind; payload: Uint8Array }
type Listener = (from: number, kind: MessageKind, payload: Uint8Array) => void

/** An in-memory host router for `n` phones (0 is the host); tests only. */
export function relayNetwork(n: number) {
  const listeners = Array.from({ length: n }, () => new Set<Listener>())
  const seen: Relay[] = []
  let sent = 0
  let rewrite: (relay: Relay) => Relay | null = (relay) => relay
  const dropped = new Set<MessageKind>()
  const lost = new Set<MessageKind>()
  const droppedFrom = new Map<MessageKind, number>()
  const duplicated = new Set<MessageKind>()
  const frameHooks = new Map<MessageKind, ((relay: Relay) => Promise<void> | void)[]>()

  const deliver = async (relay: Relay) => {
    const out = rewrite(relay)
    if (!out) return
    if (lost.has(out.kind)) return
    if (dropped.has(out.kind) && (!droppedFrom.has(out.kind) || droppedFrom.get(out.kind) === out.from))
      throw new TransportError('Interrupted')
    seen.push(out)
    for (const hook of frameHooks.get(out.kind) ?? []) await hook(out)
    const copies = duplicated.has(out.kind) ? 2 : 1
    for (let k = 0; k < copies; k++) listeners[out.to].forEach((l) => l(out.from, out.kind, out.payload.slice()))
  }

  const rawRelay = async (identified: number, relay: Relay) => {
    sent++
    const routed = relayRoute(identified, relay, n)
    if (routed) await deliver(routed)
  }

  const port = (me: number): LinkPort => ({
    me,
    send: async (to, kind, payload) => {
      if (me === 0) {
        sent++
        await deliver({ from: 0, to, kind, payload })
      } else await rawRelay(me, { from: me, to, kind, payload })
    },
    onRelay: (listener) => {
      listeners[me].add(listener)
      return () => void listeners[me].delete(listener)
    },
  })

  return {
    link: (me: number, peer: number) => new SessionLink(port(me), peer),
    port,
    rawRelay,
    framesSent: () => sent,
    seen,
    rewrite: (fn: (relay: Relay) => Relay | null) => {
      rewrite = fn
    },
    dropKind: (kind: MessageKind, options: { fromIndex?: number } = {}) => {
      dropped.add(kind)
      if (options.fromIndex !== undefined) droppedFrom.set(kind, options.fromIndex)
    },
    stopDropping: () => {
      dropped.clear()
      droppedFrom.clear()
    },
    /** The frame is sent and never arrives; the sender cannot tell. */
    drop: (kind: MessageKind) => void lost.add(kind),
    duplicateEvery: (kind: MessageKind) => void duplicated.add(kind),
    onFrame: (kind: MessageKind, hook: (relay: Relay) => Promise<void> | void) => {
      frameHooks.set(kind, [...(frameHooks.get(kind) ?? []), hook])
    },
    sawFrame: (kind: MessageKind) => seen.some((r) => r.kind === kind),
    relaysTo: (to: number) => seen.filter((r) => r.to === to),
    payloadBytesSentBy: (from: number, kind: MessageKind) =>
      seen.filter((r) => r.from === from && r.kind === kind).reduce((sum, r) => sum + r.payload.length, 0),
  }
}
