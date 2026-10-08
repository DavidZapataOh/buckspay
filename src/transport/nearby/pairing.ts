import { NearbyError, type NearbyEvent, type NearbyLink, type NearbyNative, type NearbyRole } from './types'

export const TAG_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const TAG_LENGTH = 4
export const INFO_VERSION = 1

export type PairingFailure =
  'Declined' | 'Rejected' | 'Timeout' | 'Busy' | 'RadioOff' | 'Permission' | 'Unsupported' | 'Error'

export class PairingError extends Error {
  constructor(readonly reason: PairingFailure) {
    super(reason)
    this.name = 'PairingError'
  }
}

export type PairingOptions = {
  random: (length: number) => Uint8Array
  /** How long a person has to compare the digits and answer. */
  confirmTimeoutMs: number
  /** How long a connection request has to be answered before the digits appear. */
  connectTimeoutMs: number
}

export const DEFAULT_PAIRING = { confirmTimeoutMs: 30_000, connectTimeoutMs: 20_000 } as const

export const newTag = (random: (length: number) => Uint8Array) =>
  Array.from(random(TAG_LENGTH), (byte) => TAG_ALPHABET[byte % TAG_ALPHABET.length]).join('')

const hex = (value: number) => value.toString(16).padStart(2, '0')

export const tagToInfoHex = (tag: string) =>
  hex(INFO_VERSION) + Array.from(tag, (char) => hex(char.charCodeAt(0))).join('')

export function tagFromInfoHex(infoHex: string): string | null {
  if (!new RegExp(`^${hex(INFO_VERSION)}(?:[0-9a-f]{2}){${TAG_LENGTH}}$`).test(infoHex)) return null
  const tag = String.fromCharCode(...(infoHex.slice(2).match(/../g) ?? []).map((pair) => parseInt(pair, 16)))
  return [...tag].every((char) => TAG_ALPHABET.includes(char)) ? tag : null
}

export const REQUEST_INFO_HEX = hex(INFO_VERSION)

export type Confirming = { endpointId: string; digits: string }
export type Peer = { endpointId: string; tag: string }

const FAILURES: Record<NearbyError['code'], PairingFailure> = {
  RadioOff: 'RadioOff',
  PermissionMissing: 'Permission',
  Unsupported: 'Unsupported',
  AlreadyActive: 'Busy',
  Failed: 'Error',
}

const reasonOf = (error: unknown): PairingFailure =>
  error instanceof PairingError ? error.reason : error instanceof NearbyError ? FAILURES[error.code] : 'Error'

const attempt = (call: () => Promise<void>) => call().catch(() => {})

/** What a receiver and a payer share: one request at a time, both people confirm, a way out for everything else. */
abstract class Pairing {
  readonly connected: Promise<NearbyLink>
  confirming: Confirming | null = null
  protected endpoint: string | null = null
  private done = false
  private accepted = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private resolve!: (link: NearbyLink) => void
  private reject!: (error: PairingError) => void
  private readonly watchers = new Set<(confirming: Confirming | null) => void>()
  private readonly unlisten: () => void

  protected constructor(
    protected readonly native: NearbyNative,
    protected readonly options: PairingOptions,
  ) {
    this.connected = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    this.connected.catch(() => {})
    this.unlisten = native.addListener((event) => this.onEvent(event))
  }

  protected onOther(_event: NearbyEvent) {}
  protected abstract readonly role: NearbyRole
  protected abstract stopRadio(): Promise<void>
  protected abstract onInitiated(event: Extract<NearbyEvent, { type: 'initiated' }>): void

  subscribe(listener: (confirming: Confirming | null) => void) {
    this.watchers.add(listener)
    return () => void this.watchers.delete(listener)
  }

  async confirm() {
    const current = this.confirming
    if (!current || this.accepted) return
    this.accepted = true
    try {
      await this.native.acceptConnection(current.endpointId)
    } catch (error) {
      await this.fail(reasonOf(error))
    }
  }

  async decline() {
    if (this.confirming) await this.fail('Declined')
  }

  /** Ends whatever has not ended: nothing keeps advertising, discovering or connecting. */
  async stop() {
    await this.fail('Declined')
  }

  protected get finished() {
    return this.done
  }

  protected arm(ms: number) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.fail('Timeout'), ms)
  }

  protected show(endpointId: string, digits: string) {
    this.endpoint = endpointId
    this.confirming = { endpointId, digits }
    this.notify()
    this.arm(this.options.confirmTimeoutMs)
  }

  protected async fail(reason: PairingFailure) {
    if (this.done) return
    const request = this.endpoint
    const pending = this.confirming !== null && !this.accepted
    this.close()
    this.reject(new PairingError(reason))
    await attempt(() => this.stopRadio())
    if (request)
      await attempt(() => (pending ? this.native.rejectConnection(request) : this.native.disconnect(request)))
  }

  private async succeed(endpointId: string) {
    this.close()
    await attempt(() => this.stopRadio())
    this.resolve({ endpointId, native: this.native, role: this.role })
  }

  private close() {
    this.done = true
    clearTimeout(this.timer)
    this.unlisten()
    this.confirming = null
    this.notify()
  }

  private notify() {
    for (const watcher of [...this.watchers]) watcher(this.confirming)
  }

  private onEvent(event: NearbyEvent) {
    if (this.done) return
    this.onOther(event)
    if (event.type === 'initiated') this.onInitiated(event)
    else if (event.type === 'result' && event.endpointId === this.endpoint)
      void (event.ok ? this.succeed(event.endpointId) : this.fail('Rejected'))
    else if (event.type === 'disconnected' && event.endpointId === this.endpoint) void this.fail('Error')
  }

  protected async begin(start: () => Promise<void>) {
    try {
      await start()
    } catch (error) {
      const reason = reasonOf(error)
      await this.fail(reason)
      throw new PairingError(reason)
    }
  }
}

/** The receiver: advertises a fresh tag and shows the first request that arrives. */
export class NearbyHost extends Pairing {
  protected readonly role = 'receiver'
  readonly tag: string

  private constructor(native: NearbyNative, options: PairingOptions) {
    super(native, options)
    this.tag = newTag(options.random)
  }

  static async start(native: NearbyNative, options: PairingOptions) {
    const host = new NearbyHost(native, options)
    await host.begin(() => native.startAdvertising(tagToInfoHex(host.tag)))
    return host
  }

  protected stopRadio() {
    return this.native.stopAdvertising()
  }

  protected onInitiated({ endpointId, digits }: Extract<NearbyEvent, { type: 'initiated' }>) {
    if (this.endpoint) void attempt(() => this.native.rejectConnection(endpointId))
    else this.show(endpointId, digits)
  }
}

/** The payer: lists the receivers nearby by tag and asks one of them to connect. */
export class NearbyFinder extends Pairing {
  protected readonly role = 'payer'
  peers: Peer[] = []
  private readonly peerWatchers = new Set<(peers: Peer[]) => void>()

  private constructor(native: NearbyNative, options: PairingOptions) {
    super(native, options)
  }

  static async start(native: NearbyNative, options: PairingOptions) {
    const finder = new NearbyFinder(native, options)
    await finder.begin(() => native.startDiscovery())
    return finder
  }

  subscribePeers(listener: (peers: Peer[]) => void) {
    this.peerWatchers.add(listener)
    return () => void this.peerWatchers.delete(listener)
  }

  async connect(endpointId: string) {
    if (this.finished || this.endpoint || !this.peers.some((peer) => peer.endpointId === endpointId))
      throw new PairingError('Busy')
    this.endpoint = endpointId
    this.arm(this.options.connectTimeoutMs)
    await this.begin(async () => {
      await this.native.stopDiscovery()
      await this.native.requestConnection(endpointId, REQUEST_INFO_HEX)
    })
  }

  protected stopRadio() {
    return this.native.stopDiscovery()
  }

  protected onInitiated({ endpointId, digits }: Extract<NearbyEvent, { type: 'initiated' }>) {
    if (endpointId === this.endpoint && !this.confirming) this.show(endpointId, digits)
    else void attempt(() => this.native.rejectConnection(endpointId))
  }

  protected onOther(event: NearbyEvent) {
    if (event.type === 'found') {
      const tag = tagFromInfoHex(event.infoHex)
      if (tag)
        this.setPeers([
          ...this.peers.filter((peer) => peer.endpointId !== event.endpointId),
          { endpointId: event.endpointId, tag },
        ])
    } else if (event.type === 'lost') {
      this.setPeers(this.peers.filter((peer) => peer.endpointId !== event.endpointId))
    }
  }

  private setPeers(peers: Peer[]) {
    this.peers = peers
    for (const watcher of [...this.peerWatchers]) watcher(peers)
  }
}
