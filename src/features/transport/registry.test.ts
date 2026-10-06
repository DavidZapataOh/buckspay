import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createNfcTransport } from '../../transport/nfc/transport'
import { createLoopbackPair } from '../../transport/testing/loopback'
import { createNearbyEntry, nfcEntry, nfcRoleFor, qrEntry } from './registry'

const { pause, resume } = vi.hoisted(() => ({ pause: vi.fn(async () => {}), resume: vi.fn(async () => {}) }))
vi.mock('../../transport/nfc/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../transport/nfc/transport')>()
  return { ...actual, createNfcTransport: vi.fn(actual.createNfcTransport) }
})
vi.mock('./mesh-yield', () => ({ meshPause: pause, meshResume: resume }))
vi.mock('../nearby/handoff', () => ({ openPairing: vi.fn() }))
vi.mock('../../transport/nearby/native', () => ({ nearbyNative: { support: vi.fn() } }))
vi.mock('../../transport/nfc/native', () => ({
  nfcNative: {
    support: vi.fn(async () => ({ hardware: true, hce: true, enabled: false, reader: true })),
    acquire: vi.fn(),
    release: vi.fn(async () => {}),
    cancel: vi.fn(),
    addProgressListener: vi.fn(() => () => {}),
  },
}))

beforeEach(() => {
  pause.mockClear()
  resume.mockClear()
})

describe('registry', () => {
  it('the QR entry starts the screen session transport, without pairing', async () => {
    const [transport] = createLoopbackPair()
    const qr = qrEntry({ transport })
    expect(await qr.start('receiver')).toBe(transport)
    expect(await qr.check()).toEqual({ ready: true })
  })

  it('maps the receiver to the card and the payer to the reader', () => {
    expect(nfcRoleFor('receiver')).toBe('card')
    expect(nfcRoleFor('payer')).toBe('reader')
  })

  it('the NFC entry reports what the phone says and starts an NFC transport', async () => {
    expect(await nfcEntry.check()).toEqual({ ready: false, reason: 'disabled' })
    const transport = await nfcEntry.start('payer')
    expect(transport.id).toBe('nfc')
    await transport.close()
    await (await nfcEntry.start('receiver')).close()
    expect(vi.mocked(createNfcTransport).mock.calls.map(([, role]) => role)).toEqual(['reader', 'card'])
  })

  it('pauses the mesh while a Nearby transport is open and resumes it when it closes', async () => {
    const [link] = createLoopbackPair()
    const entry = createNearbyEntry(async () => link)
    const transport = await entry.start('payer')
    expect(pause).toHaveBeenCalledOnce()
    expect(resume).not.toHaveBeenCalled()
    await transport.close()
    expect(resume).toHaveBeenCalledOnce()
  })

  it('resumes the mesh when pairing fails', async () => {
    const entry = createNearbyEntry(async () => {
      throw new Error('Busy')
    })
    await expect(entry.start('receiver')).rejects.toThrow('Busy')
    expect(resume).toHaveBeenCalledOnce()
  })
})
