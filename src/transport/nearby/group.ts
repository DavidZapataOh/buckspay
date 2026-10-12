import { NearbyError, type NearbyEvent, type NearbyMode, type NearbyNative } from './types'

export const MAX_SPOKES = 7
export const GROUP_INFO_VERSION = 2
export const GROUP_JOIN_TIMEOUT_MS = 30_000

export type GroupMode = Exclude<NearbyMode, 'pay'>
export type LinkEvent = { type: 'up' | 'down'; endpoint: string }
export type GroupFailure = 'RadioOff' | 'Permission' | 'Unsupported' | 'Busy' | 'Timeout' | 'Rejected' | 'Error'

export class GroupError extends Error {
  constructor(readonly reason: GroupFailure) {
    super(reason)
    this.name = 'GroupError'
  }
}

/** One connection to every member of a session: the hub holds up to seven, a spoke holds the hub. */
export type GroupWire = {
  readonly role: 'hub' | 'spoke'
  readonly mode: GroupMode
  /** Spoke: to the hub (`to` ignored). Hub: to the member `index` named by `identify`; rejects when it is not connected. */
  send(frame: Uint8Array, to?: number): Promise<void>
  /** Hub: to every identified member, one after another. */
  broadcast(frame: Uint8Array): Promise<void>
  /** Hub: the frames arriving on `endpoint` belong to member `index` from now on (called once its first frame opened). */
  identify(endpoint: string, index: number): void
  onFrame(listener: (frame: Uint8Array, from: string) => void): () => void
  onLink(listener: (event: LinkEvent) => void): () => void
  spokes(): number
  drop(endpoint: string): Promise<void>
  close(): Promise<void>
}

const hex = (value: number) => value.toString(16).padStart(2, '0')

/** The advertisement info is `GROUP_INFO_VERSION ‖ tag` (hex), so a pay advertisement is never mistaken for a group one. */
export const groupInfoHex = (tag: Uint8Array): string => `${hex(GROUP_INFO_VERSION)}${Array.from(tag, hex).join('')}`

const REASONS: Record<NearbyError['code'], GroupFailure> = {
  RadioOff: 'RadioOff',
  PermissionMissing: 'Permission',
  Unsupported: 'Unsupported',
  AlreadyActive: 'Busy',
  Failed: 'Error',
}

export const groupErrorOf = (error: unknown): GroupError =>
  error instanceof GroupError ? error : new GroupError(error instanceof NearbyError ? REASONS[error.code] : 'Error')

/** What every group wire shares: the frame pump, ordered sends per endpoint and the link events. */
export class GroupLinks implements GroupWire {
  protected readonly connected = new Set<string>()
  protected readonly members = new Map<number, string>()
  protected closed = false
  readonly #frames = new Set<(frame: Uint8Array, from: string) => void>()
  readonly #links = new Set<(event: LinkEvent) => void>()
  readonly #tails = new Map<string, Promise<void>>()
  readonly #unlisten: () => void
  #pump: Promise<void> = Promise.resolve()

  constructor(
    readonly role: 'hub' | 'spoke',
    readonly mode: GroupMode,
    protected readonly native: NearbyNative,
  ) {
    this.#unlisten = native.addListener((event) => this.handle(event))
  }

  protected handle(event: NearbyEvent): void {
    switch (event.type) {
      case 'result':
        if (event.ok) this.up(event.endpointId)
        break
      case 'message':
        if (this.connected.has(event.endpointId)) this.#drain(event.endpointId)
        break
      case 'disconnected':
        this.down(event.endpointId)
        break
    }
  }

  protected up(endpoint: string): void {
    if (this.closed || this.connected.has(endpoint)) return
    this.connected.add(endpoint)
    this.emitLink({ type: 'up', endpoint })
  }

  protected down(endpoint: string): void {
    if (!this.connected.delete(endpoint)) return
    this.#tails.delete(endpoint)
    this.emitLink({ type: 'down', endpoint })
  }

  protected emitLink(event: LinkEvent): void {
    this.#links.forEach((listener) => listener(event))
  }

  #drain(endpoint: string): void {
    this.#pump = this.#pump.then(async () => {
      try {
        for (
          let frame = await this.native.takeMessage(endpoint);
          frame;
          frame = await this.native.takeMessage(endpoint)
        ) {
          const received = frame
          this.#frames.forEach((listener) => listener(received, endpoint))
        }
      } catch {
        await this.drop(endpoint)
      }
    })
  }

  protected endpointFor(to: number | undefined): string {
    const endpoint = this.role === 'hub' ? this.members.get(to ?? -1) : this.connected.values().next().value
    if (!endpoint || !this.connected.has(endpoint)) throw new GroupError('Error')
    return endpoint
  }

  async send(frame: Uint8Array, to?: number): Promise<void> {
    const endpoint = this.endpointFor(to)
    const previous = this.#tails.get(endpoint) ?? Promise.resolve()
    const run = () => this.native.sendBytes(endpoint, frame).catch((error) => Promise.reject(groupErrorOf(error)))
    const sent = previous.then(run, run)
    this.#tails.set(
      endpoint,
      sent.then(
        () => undefined,
        () => undefined,
      ),
    )
    return sent
  }

  async broadcast(frame: Uint8Array): Promise<void> {
    for (const index of [...this.members.keys()].sort((a, b) => a - b)) await this.send(frame, index)
  }

  identify(endpoint: string, index: number): void {
    this.members.set(index, endpoint)
  }

  onFrame(listener: (frame: Uint8Array, from: string) => void): () => void {
    this.#frames.add(listener)
    return () => void this.#frames.delete(listener)
  }

  onLink(listener: (event: LinkEvent) => void): () => void {
    this.#links.add(listener)
    return () => void this.#links.delete(listener)
  }

  spokes(): number {
    return this.connected.size
  }

  async drop(endpoint: string): Promise<void> {
    const wasConnected = this.connected.has(endpoint)
    this.down(endpoint)
    if (wasConnected) await this.native.disconnect(endpoint).catch((error) => Promise.reject(groupErrorOf(error)))
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.#unlisten()
    this.connected.clear()
    this.members.clear()
    await this.native.stopAll().catch((error) => Promise.reject(groupErrorOf(error)))
  }
}

/** The hub of a star: accepts the spokes that carry its tag, up to `maxSpokes`, and nobody else. */
export class StarHub extends GroupLinks {
  readonly #expected: string
  readonly #accepting = new Set<string>()

  constructor(
    native: NearbyNative,
    tag: Uint8Array,
    mode: GroupMode,
    private readonly maxSpokes: number,
  ) {
    super('hub', mode, native)
    this.#expected = groupInfoHex(tag)
  }

  get info(): string {
    return this.#expected
  }

  protected override handle(event: NearbyEvent): void {
    if (event.type === 'initiated') {
      this.#answer(event)
      return
    }
    if (event.type === 'result') this.#accepting.delete(event.endpointId)
    super.handle(event)
  }

  #answer(event: Extract<NearbyEvent, { type: 'initiated' }>): void {
    const { endpointId } = event
    const welcome = event.infoHex === this.#expected && this.connected.size + this.#accepting.size < this.maxSpokes
    if (!welcome) {
      this.native.rejectConnection(endpointId).catch(() => this.emitLink({ type: 'down', endpoint: endpointId }))
      return
    }
    this.#accepting.add(endpointId)
    this.native.acceptConnection(endpointId).catch(() => {
      this.#accepting.delete(endpointId)
      this.emitLink({ type: 'down', endpoint: endpointId })
    })
  }
}

export type DialOptions = { tag: Uint8Array; mode: GroupMode; timeoutMs: number; signal?: AbortSignal }

/** Finds the hub that carries `tag`, asks for a connection and resolves with its endpoint once the link is up. */
export function dial(native: NearbyNative, wire: GroupWire, options: DialOptions): Promise<string> {
  const expected = groupInfoHex(options.tag)
  return new Promise<string>((resolve, reject) => {
    let target: string | null = null
    let finished = false
    const finish = (cleanup: boolean, outcome: () => void) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      unlisten()
      offLink()
      if (!cleanup) return outcome()
      const stopped = native.stopDiscovery().then(() => (target ? native.disconnect(target) : undefined))
      stopped.then(outcome, (error) => reject(groupErrorOf(error)))
    }
    const fail = (error: unknown) => finish(true, () => reject(groupErrorOf(error)))
    const onAbort = () => fail(new GroupError('Error'))
    const timer = setTimeout(() => fail(new GroupError('Timeout')), options.timeoutMs)
    const unlisten = native.addListener((event) => {
      if (event.type === 'found' && !target && event.infoHex === expected) {
        target = event.endpointId
        native
          .stopDiscovery()
          .then(() => native.requestConnection(event.endpointId, expected))
          .catch(fail)
      } else if (event.type === 'initiated' && event.endpointId === target) {
        native.acceptConnection(event.endpointId).catch(fail)
      } else if (event.type === 'result' && event.endpointId === target && !event.ok) {
        fail(new GroupError('Rejected'))
      }
    })
    const offLink = wire.onLink((event) => {
      if (event.type === 'up') finish(false, () => resolve(event.endpoint))
    })
    options.signal?.addEventListener('abort', onAbort)
    if (options.signal?.aborted) return onAbort()
    native.startDiscovery(options.mode).catch(fail)
  })
}

export async function startHub(
  native: NearbyNative,
  options: { tag: Uint8Array; mode?: GroupMode; maxSpokes?: number },
): Promise<GroupWire> {
  const mode = options.mode ?? 'group'
  const hub = new StarHub(native, options.tag, mode, options.maxSpokes ?? MAX_SPOKES)
  try {
    await native.startAdvertising(hub.info, mode)
  } catch (error) {
    await hub.close()
    throw groupErrorOf(error)
  }
  return hub
}

export async function joinHub(
  native: NearbyNative,
  options: { tag: Uint8Array; mode?: GroupMode; timeoutMs?: number; signal?: AbortSignal },
): Promise<GroupWire> {
  const mode = options.mode ?? 'group'
  const spoke = new GroupLinks('spoke', mode, native)
  try {
    await dial(native, spoke, {
      tag: options.tag,
      mode,
      timeoutMs: options.timeoutMs ?? GROUP_JOIN_TIMEOUT_MS,
      signal: options.signal,
    })
  } catch (error) {
    await spoke.close()
    throw groupErrorOf(error)
  }
  return spoke
}
