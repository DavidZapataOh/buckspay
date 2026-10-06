import { describe, expect, it, vi } from 'vitest'
import { encodeFrame, FrameKind } from './frame'
import { meshTask } from './task'

const conflict = new Uint8Array(227).fill(7)
const beacon = new Uint8Array(9).fill(1)
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

describe('the headless task', () => {
  it('dispatches each decodable frame to its handler with its RSSI and ignores the rest', async () => {
    const onConflict = vi.fn(async () => {})
    const onBeacon = vi.fn(async () => {})
    const task = meshTask({ [FrameKind.SpendConflict]: onConflict, [FrameKind.Beacon]: onBeacon })
    await task({
      frames: [
        b64(encodeFrame({ kind: FrameKind.SpendConflict, payload: conflict })),
        b64(Uint8Array.of(9)),
        b64(encodeFrame({ kind: FrameKind.Beacon, payload: beacon })),
      ],
      rssi: [-60, -70, -80],
      addresses: ['a', 'b', 'c'],
    })
    expect(onConflict).toHaveBeenCalledWith(conflict, -60, 'a')
    expect(onBeacon).toHaveBeenCalledWith(beacon, -80, 'c')
    expect(onConflict).toHaveBeenCalledTimes(1)
  })

  it('one failing handler does not stop the others', async () => {
    const ok = vi.fn(async () => {})
    const task = meshTask({
      [FrameKind.SpendConflict]: async () => {
        throw new Error('x')
      },
      [FrameKind.Beacon]: ok,
    })
    await task({
      frames: [
        b64(encodeFrame({ kind: FrameKind.SpendConflict, payload: conflict })),
        b64(encodeFrame({ kind: FrameKind.Beacon, payload: beacon })),
      ],
      rssi: [0, 0],
    })
    expect(ok).toHaveBeenCalledOnce()
  })

  it('tells the unlock handler only when the phone was unlocked, even if it fails', async () => {
    const onUnlock = vi.fn(async () => {
      throw new Error('locked again')
    })
    const task = meshTask({}, { onUnlock })
    await task({ frames: [], rssi: [] })
    expect(onUnlock).not.toHaveBeenCalled()
    await expect(task({ frames: [], rssi: [], unlocked: true })).resolves.toBeUndefined()
    expect(onUnlock).toHaveBeenCalledOnce()
  })

  it('hands each phone that connected to the channel handler with its address', async () => {
    const onChannel = vi.fn(async () => {})
    await meshTask({}, { onChannel })({ frames: [], rssi: [], channels: [4, 5], peers: ['a', 'b'] })
    expect(onChannel.mock.calls).toEqual([
      [4, 'a'],
      [5, 'b'],
    ])
  })

  it('does not take a connection for an unlock', async () => {
    const onUnlock = vi.fn(async () => {})
    await meshTask({}, { onUnlock })({ frames: [], rssi: [], channels: [4] })
    expect(onUnlock).not.toHaveBeenCalled()
  })
})
