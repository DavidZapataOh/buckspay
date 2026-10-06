import { beforeEach, describe, expect, it, vi } from 'vitest'
import { meshPause, meshResume } from './mesh-yield'

const native = vi.hoisted(() => ({ pause: vi.fn(async () => {}), resume: vi.fn(async () => {}) }))
vi.mock('../mesh/native', () => ({ meshNative: native }))

beforeEach(() => vi.clearAllMocks())

describe('the mesh yields to a Nearby link', () => {
  it('pauses and resumes the module', async () => {
    await meshPause()
    expect(native.pause).toHaveBeenCalledOnce()
    await meshResume()
    expect(native.resume).toHaveBeenCalledOnce()
  })

  it('never fails a payment when the mesh is not running', async () => {
    native.pause.mockRejectedValueOnce(new Error('not running'))
    await expect(meshPause()).resolves.toBeUndefined()
  })
})
