import { act } from 'react'
import { create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { fakeMeshNative } from './testing/fake-native'
import { type Mesh, useMesh } from './use-mesh'
import type { MeshNative } from './native'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

async function mount(native: MeshNative) {
  const seen: Mesh[] = []
  function Probe() {
    seen.push(useMesh(native))
    return null
  }
  await act(async () => {
    create(<Probe />)
  })
  return { current: () => seen[seen.length - 1] }
}

describe('useMesh', () => {
  it('turning the switch off stops the service and is remembered', async () => {
    const native = fakeMeshNative()
    const first = await mount(native)
    await act(() => first.current().setEnabled(true))
    expect(native.running()).toBe(true)
    expect(first.current().enabled).toBe(true)
    await act(() => first.current().setEnabled(false))
    expect(native.running()).toBe(false)
    expect((await mount(native)).current().enabled).toBe(false)
  })

  it('reports Bluetooth off instead of failing silently, and leaves the switch off', async () => {
    const native = fakeMeshNative({ startError: 'bluetooth-off' })
    const mesh = await mount(native)
    await act(() => mesh.current().setEnabled(true))
    expect(mesh.current().problem).toBe('bluetooth-off')
    expect(mesh.current().enabled).toBe(false)
  })

  it('reports a denied permission', async () => {
    const mesh = await mount(fakeMeshNative({ startError: 'permission-denied' }))
    await act(() => mesh.current().setEnabled(true))
    expect(mesh.current().problem).toBe('permission-denied')
  })

  it('clears the problem when the person tries again', async () => {
    const native = fakeMeshNative()
    const start = native.start
    let first = true
    native.start = async () => {
      if (first) {
        first = false
        throw Object.assign(new Error('off'), { code: 'bluetooth-off' })
      }
      await start()
    }
    const mesh = await mount(native)
    await act(() => mesh.current().setEnabled(true))
    expect(mesh.current().problem).toBe('bluetooth-off')
    await act(() => mesh.current().setEnabled(true))
    expect(mesh.current().problem).toBeUndefined()
    expect(mesh.current().enabled).toBe(true)
  })
})
