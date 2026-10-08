import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newInvite } from './channel'
import { openHub } from './open-group'

const { pause, resume } = vi.hoisted(() => ({ pause: vi.fn(async () => {}), resume: vi.fn(async () => {}) }))
vi.mock('../transport/mesh-yield', () => ({ meshPause: pause, meshResume: resume }))
vi.mock('../../transport/nearby/native', async () => {
  const { FakeAir } = await import('../../transport/nearby/testing/fake')
  return { nearbyNative: new FakeAir().phone() }
})

beforeEach(() => {
  pause.mockClear()
  resume.mockClear()
})
const invite = newInvite((n) => new Uint8Array(n).fill(3))

describe('open-group', () => {
  it('pauses_the_mesh_before_the_radio_and_resumes_it_when_the_wire_closes', async () => {
    const wire = await openHub(invite)
    expect(pause).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()
    await wire.close()
    await wire.close()
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('resumes_the_mesh_when_the_start_fails', async () => {
    const { nearbyNative } = await import('../../transport/nearby/native')
    const { NearbyError } = await import('../../transport/nearby/types')
    ;(nearbyNative as unknown as { failNext: Error }).failNext = new NearbyError('RadioOff')
    await expect(openHub(invite)).rejects.toMatchObject({ reason: 'RadioOff' })
    expect(resume).toHaveBeenCalledTimes(1)
  })
})
