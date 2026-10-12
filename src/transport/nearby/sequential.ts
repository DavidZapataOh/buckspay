import {
  dial,
  GROUP_JOIN_TIMEOUT_MS,
  type GroupMode,
  GroupError,
  GroupLinks,
  type GroupWire,
  groupErrorOf,
  StarHub,
} from './group'
import type { NearbyEvent, NearbyNative } from './types'

export const SEQUENTIAL_WAIT_MS = 30_000
/** How often a spoke that lost the hub, or found it busy with another member, asks again. */
export const SEQUENTIAL_RETRY_MS = 1_000

const MODE: GroupMode = 'groupSequential'
const PERMANENT = new Set(['RadioOff', 'Permission', 'Unsupported', 'Busy'])

/** A hub that serves one member at a time: to talk to another member it hangs up and waits for that member to call back. */
class SequentialHub extends StarHub {
  readonly #watchers = new Set<() => void>()
  readonly #hungUp = new Set<string>()

  constructor(native: NearbyNative, tag: Uint8Array) {
    super(native, tag, MODE, 1)
  }

  protected override handle(event: NearbyEvent): void {
    super.handle(event)
    if (event.type === 'result' && event.ok) this.#hungUp.delete(event.endpointId)
    if (event.type === 'result' || event.type === 'disconnected') this.#watchers.forEach((watch) => watch())
  }

  override identify(endpoint: string, index: number): void {
    super.identify(endpoint, index)
    this.#watchers.forEach((watch) => watch())
  }

  override async drop(endpoint: string): Promise<void> {
    this.#hungUp.add(endpoint)
    return super.drop(endpoint)
  }

  override async send(frame: Uint8Array, to?: number): Promise<void> {
    await this.#serve(to)
    return super.send(frame, to)
  }

  async #serve(to: number | undefined): Promise<void> {
    if (to === undefined || !this.members.has(to)) throw new GroupError('Error')
    const ready = () => {
      const endpoint = this.members.get(to)
      return endpoint !== undefined && this.connected.has(endpoint)
    }
    if (ready()) return
    const gone = this.connected.size === 0 && !this.#hungUp.has(this.members.get(to) ?? '')
    if (gone) throw new GroupError('Timeout')
    for (const endpoint of [...this.connected]) await this.drop(endpoint)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => settle(() => reject(new GroupError('Timeout'))), SEQUENTIAL_WAIT_MS)
      const watch = () => {
        if (ready()) return settle(resolve)
        for (const endpoint of this.connected)
          if (endpoint !== this.members.get(to) && this.#known(endpoint)) void this.drop(endpoint)
      }
      const settle = (done: () => void) => {
        clearTimeout(timer)
        this.#watchers.delete(watch)
        done()
      }
      this.#watchers.add(watch)
      watch()
    })
  }

  #known(endpoint: string): boolean {
    return [...this.members.values()].includes(endpoint)
  }
}

/** A spoke that dials again whenever the hub hung up, for as long as its wire is open. */
class SequentialSpoke extends GroupLinks {
  constructor(
    native: NearbyNative,
    private readonly tag: Uint8Array,
  ) {
    super('spoke', MODE, native)
  }

  #dialing = false

  protected override down(endpoint: string): void {
    super.down(endpoint)
    if (!this.closed) this.redial().catch(() => this.close())
  }

  async redial(deadlineMs = Infinity): Promise<void> {
    if (this.#dialing) return
    this.#dialing = true
    try {
      await this.#loop(deadlineMs)
    } finally {
      this.#dialing = false
    }
  }

  async #loop(deadlineMs: number): Promise<void> {
    const until = Date.now() + deadlineMs
    while (!this.closed && Date.now() < until) {
      try {
        await dial(this.native, this, { tag: this.tag, mode: MODE, timeoutMs: SEQUENTIAL_RETRY_MS })
        return
      } catch (error) {
        const reason = groupErrorOf(error).reason
        if (PERMANENT.has(reason)) throw error
        await new Promise((resolve) => setTimeout(resolve, SEQUENTIAL_RETRY_MS))
      }
    }
  }
}

export async function startSequentialHub(native: NearbyNative, options: { tag: Uint8Array }): Promise<GroupWire> {
  const hub = new SequentialHub(native, options.tag)
  try {
    await native.startAdvertising(hub.info, MODE)
  } catch (error) {
    await hub.close()
    throw groupErrorOf(error)
  }
  return hub
}

export async function joinSequentialHub(
  native: NearbyNative,
  options: { tag: Uint8Array; timeoutMs?: number },
): Promise<GroupWire> {
  const spoke = new SequentialSpoke(native, options.tag)
  try {
    await spoke.redial(options.timeoutMs ?? GROUP_JOIN_TIMEOUT_MS)
    if (spoke.spokes() === 0) throw new GroupError('Timeout')
  } catch (error) {
    await spoke.close()
    throw groupErrorOf(error)
  }
  return spoke
}
