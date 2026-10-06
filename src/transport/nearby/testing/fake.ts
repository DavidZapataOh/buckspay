import { NearbyError, type NearbyEvent, type NearbyNative, type NearbySupport } from '../types'

type Listener = (event: NearbyEvent) => void

/** Phones in one room, with the callback order of Nearby Connections. Test double, never shipped. */
export class FakeAir {
  readonly phones: FakePhone[] = []
  phone(support: Partial<NearbySupport> = {}): FakePhone {
    const phone = new FakePhone(this, `E${this.phones.length + 1}`, {
      playServices: true,
      permissions: true,
      bluetooth: true,
      ...support,
    })
    this.phones.push(phone)
    return phone
  }
  /** Two phones that already hold an accepted connection to each other. */
  connectedPair(): [FakePhone, FakePhone] {
    const a = this.phone()
    const b = this.phone()
    a.link(b)
    return [a, b]
  }
  byId(id: string) {
    return this.phones.find((p) => p.id === id)
  }
}

export class FakePhone implements NearbyNative {
  readonly calls: { method: string; args: unknown[] }[] = []
  advertising: string | null = null
  discovering = false
  failNext: NearbyError | null = null
  private listeners = new Set<Listener>()
  private inbox = new Map<string, Uint8Array[]>()
  private accepted = new Set<string>()
  private connected = new Set<string>()
  private digitsFor = new Map<string, string>()

  constructor(
    private readonly air: FakeAir,
    readonly id: string,
    private readonly supportValue: NearbySupport,
  ) {}

  private log(method: string, ...args: unknown[]) {
    this.calls.push({ method, args })
    if (this.failNext) {
      const error = this.failNext
      this.failNext = null
      throw error
    }
  }

  emit(event: NearbyEvent) {
    queueMicrotask(() => this.listeners.forEach((l) => l(event)))
  }

  async support() {
    return this.supportValue
  }
  addListener(listener: Listener) {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  async startAdvertising(infoHex: string) {
    this.log('startAdvertising', infoHex)
    if (this.advertising) throw new NearbyError('AlreadyActive')
    this.advertising = infoHex
    for (const other of this.air.phones)
      if (other.discovering) other.emit({ type: 'found', endpointId: this.id, infoHex })
  }
  async stopAdvertising() {
    this.log('stopAdvertising')
    if (!this.advertising) return
    this.advertising = null
    for (const other of this.air.phones) if (other.discovering) other.emit({ type: 'lost', endpointId: this.id })
  }
  async startDiscovery() {
    this.log('startDiscovery')
    this.discovering = true
    for (const other of this.air.phones)
      if (other.advertising) this.emit({ type: 'found', endpointId: other.id, infoHex: other.advertising })
  }
  async stopDiscovery() {
    this.log('stopDiscovery')
    this.discovering = false
  }
  async requestConnection(endpointId: string, infoHex: string) {
    this.log('requestConnection', endpointId, infoHex)
    const target = this.air.byId(endpointId)
    if (!target?.advertising) throw new NearbyError('Failed')
    const digits = String(1000 + Math.floor(Math.random() * 9000))
    this.digitsFor.set(endpointId, digits)
    target.digitsFor.set(this.id, digits)
    this.emit({ type: 'initiated', endpointId, digits, incoming: false, infoHex: target.advertising })
    target.emit({ type: 'initiated', endpointId: this.id, digits, incoming: true, infoHex })
  }
  async acceptConnection(endpointId: string) {
    this.log('acceptConnection', endpointId)
    this.accepted.add(endpointId)
    const peer = this.air.byId(endpointId)!
    if (peer.accepted.has(this.id)) {
      this.connected.add(endpointId)
      peer.connected.add(this.id)
      this.emit({ type: 'result', endpointId, ok: true })
      peer.emit({ type: 'result', endpointId: this.id, ok: true })
    }
  }
  async rejectConnection(endpointId: string) {
    this.log('rejectConnection', endpointId)
    this.air.byId(endpointId)?.emit({ type: 'result', endpointId: this.id, ok: false })
    this.emit({ type: 'result', endpointId, ok: false })
  }
  async sendBytes(endpointId: string, bytes: Uint8Array) {
    this.log('sendBytes', endpointId, bytes.length)
    const peer = this.air.byId(endpointId)
    if (!peer || !this.connected.has(endpointId) || !peer.connected.has(this.id)) throw new NearbyError('Failed')
    await new Promise((r) => setTimeout(r, 1))
    const box = peer.inbox.get(this.id) ?? []
    box.push(bytes.slice())
    peer.inbox.set(this.id, box)
    peer.emit({ type: 'message', endpointId: this.id })
  }
  async takeMessage(endpointId: string) {
    return this.inbox.get(endpointId)?.shift() ?? null
  }
  async disconnect(endpointId: string) {
    this.log('disconnect', endpointId)
    const peer = this.air.byId(endpointId)
    const was = this.connected.delete(endpointId) || this.accepted.delete(endpointId)
    peer?.connected.delete(this.id)
    peer?.accepted.delete(this.id)
    if (was) peer?.emit({ type: 'disconnected', endpointId: this.id })
  }
  async stopAll() {
    this.log('stopAll')
    this.advertising = null
    this.discovering = false
    for (const id of [...this.connected]) await this.disconnect(id)
  }

  link(other: FakePhone) {
    this.connected.add(other.id)
    other.connected.add(this.id)
  }

  /** Test helper: the other phone's radio dies. */
  drop(endpointId: string) {
    this.connected.delete(endpointId)
    this.air.byId(endpointId)?.connected.delete(this.id)
    this.emit({ type: 'disconnected', endpointId })
    this.air.byId(endpointId)?.emit({ type: 'disconnected', endpointId: this.id })
  }
  /** Test helper: a raw payload arrives as if the peer's app sent it. */
  inject(endpointId: string, bytes: Uint8Array) {
    const box = this.inbox.get(endpointId) ?? []
    box.push(bytes)
    this.inbox.set(endpointId, box)
    this.emit({ type: 'message', endpointId })
  }
}
