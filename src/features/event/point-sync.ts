import { type ConsumedEntry, entriesSince } from './consumed'
import type { PointPairing } from './payloads'
import { applySync, decodeSync, encodeSync, MAX_SYNC_ENTRIES } from './sync'
import type { NoteDb } from '../notes/db'
import { MessageKind, type Transport } from '../../transport/types'
import type { SpendConflict } from '../../protocol'

/** Seconds between full exchanges: every accepted payment is also pushed at once. */
export const SYNC_INTERVAL_SECONDS = 30

export type SyncStatus = { peers: number; syncedAt: number | null }

type Options = {
  db: NoteDb
  pairing: PointPairing
  noteDomain: Uint8Array
  /** This point's id in sync messages; random per session. */
  from: Uint8Array
  now: () => number
  onConflict?: (conflict: SpendConflict) => void
  onChange?: (status: SyncStatus) => void
}

/** What one point tells and hears from the points it is linked to, so a spend at one is known at the others. */
export class PointSync {
  private readonly peers = new Set<Transport>()
  private readonly stop = new AbortController()
  private syncedAt: number | null = null
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly options: Options) {}

  status(): SyncStatus {
    return { peers: this.peers.size, syncedAt: this.syncedAt }
  }

  /** Links a point and starts hearing it. */
  attach(transport: Transport) {
    this.peers.add(transport)
    this.options.onChange?.(this.status())
    void this.listen(transport)
  }

  /** Starts the exchange of everything this point recorded, every `SYNC_INTERVAL_SECONDS`. */
  start() {
    this.timer ??= setInterval(() => void this.exchange(), SYNC_INTERVAL_SECONDS * 1000)
  }

  /** Tells every linked point about `entries`, at most `MAX_SYNC_ENTRIES` to a message. */
  async push(entries: ConsumedEntry[]) {
    const { pairing, from } = this.options
    for (let i = 0; i < entries.length; i += MAX_SYNC_ENTRIES) {
      const payload = encodeSync(pairing.eventSecret, {
        eventId: pairing.eventId,
        from,
        entries: entries.slice(i, i + MAX_SYNC_ENTRIES),
      })
      await Promise.all([...this.peers].map((peer) => this.send(peer, payload)))
    }
  }

  /** Tells every linked point everything this point recorded. */
  async exchange() {
    await this.push(await entriesSince(this.options.db, this.options.pairing.eventId, 0))
  }

  async close() {
    clearInterval(this.timer)
    this.stop.abort()
    await Promise.all([...this.peers].map((peer) => peer.close()))
    this.peers.clear()
  }

  private async send(peer: Transport, payload: Uint8Array) {
    try {
      await peer.send({ kind: MessageKind.EventSync, payload }, { signal: this.stop.signal })
    } catch {
      this.drop(peer)
    }
  }

  private drop(peer: Transport) {
    if (this.peers.delete(peer)) this.options.onChange?.(this.status())
  }

  private async listen(peer: Transport) {
    const { db, pairing, noteDomain, now, onConflict, onChange } = this.options
    while (this.peers.has(peer) && !this.stop.signal.aborted) {
      let message
      try {
        message = await peer.receive({ accept: [MessageKind.EventSync], signal: this.stop.signal })
      } catch {
        this.drop(peer)
        return
      }
      const heard = decodeSync(pairing.eventSecret, message.payload)
      if (!heard || heard.eventId.some((byte, i) => byte !== pairing.eventId[i])) continue
      const { conflicts } = await applySync(db, pairing, noteDomain, heard.entries)
      this.syncedAt = now()
      onChange?.(this.status())
      conflicts.forEach((conflict) => onConflict?.(conflict))
    }
  }
}
