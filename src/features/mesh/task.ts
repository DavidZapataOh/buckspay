import { decodeFrame, type Frame } from './frame'

export type MeshHandlers = {
  [K in Frame['kind']]?: (payload: Uint8Array, rssi: number, address: string) => Promise<void>
}
/** `addresses` and `rssi` run parallel to `frames`; `channels` are phones that connected to this one, with `peers` their addresses. */
export type MeshTaskData = {
  frames: string[]
  rssi: number[]
  addresses?: string[]
  channels?: number[]
  peers?: string[]
  unlocked?: boolean
}
export type MeshTaskCallbacks = {
  onUnlock?: () => Promise<void>
  onChannel?: (channel: number, peer: string) => Promise<void>
}

/** The headless task: hands each decodable frame to the handler of its kind, a channel to `onChannel`, and tells `onUnlock` when the phone was unlocked. */
export function meshTask(handlers: MeshHandlers, { onUnlock, onChannel }: MeshTaskCallbacks = {}) {
  return async ({ frames, rssi, addresses = [], channels = [], peers = [], unlocked }: MeshTaskData): Promise<void> => {
    const work = frames.map(async (encoded, index) => {
      const frame = decodeFrame(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)))
      if (frame) await handlers[frame.kind]?.(frame.payload, rssi[index], addresses[index] ?? '')
    })
    if (onChannel) for (const [index, channel] of channels.entries()) work.push(onChannel(channel, peers[index] ?? ''))
    if (unlocked && onUnlock) work.push(onUnlock())
    await Promise.allSettled(work)
  }
}
