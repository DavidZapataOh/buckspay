import { decodeFrame, type Frame } from './frame'

export type MeshHandlers = { [K in Frame['kind']]?: (payload: Uint8Array, rssi: number) => Promise<void> }
export type MeshTaskData = { frames: string[]; rssi: number[]; unlocked?: boolean }

/** The headless task: hands each decodable frame to the handler of its kind, and tells `onUnlock` when the phone was unlocked. */
export function meshTask(handlers: MeshHandlers, onUnlock?: () => Promise<void>) {
  return async ({ frames, rssi, unlocked }: MeshTaskData): Promise<void> => {
    const work = frames.map(async (encoded, index) => {
      const frame = decodeFrame(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)))
      if (frame) await handlers[frame.kind]?.(frame.payload, rssi[index])
    })
    if (unlocked && onUnlock) work.push(onUnlock())
    await Promise.allSettled(work)
  }
}
