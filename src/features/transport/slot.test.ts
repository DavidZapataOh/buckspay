import { describe, expect, it, vi } from 'vitest'
import { createLoopbackPair } from '../../transport/testing/loopback'
import type { TransportEntry } from './registry'
import { createTransportSlot } from './slot'

const entry = (id: 'qr' | 'nearby') => {
  const closed = vi.fn()
  const start = vi.fn(async () => {
    const [transport] = createLoopbackPair()
    const close = transport.close.bind(transport)
    transport.close = async () => {
      closed()
      await close()
    }
    return transport
  })
  return {
    entry: { id, label: id, check: async () => ({ ready: true as const }), start } as TransportEntry,
    closed,
    start,
  }
}

describe('transport slot', () => {
  it('starts a new transport for each payment and closes the previous one first', async () => {
    const nearby = entry('nearby')
    const slot = createTransportSlot()
    await slot.open(nearby.entry, 'payer')
    await slot.open(nearby.entry, 'payer')
    expect(nearby.start).toHaveBeenCalledTimes(2)
    expect(nearby.closed).toHaveBeenCalledTimes(1)
    await slot.close()
    expect(nearby.closed).toHaveBeenCalledTimes(2)
    await slot.close()
    expect(nearby.closed).toHaveBeenCalledTimes(2)
  })

  it('never closes the QR transport, which its screen owns', async () => {
    const qr = entry('qr')
    const slot = createTransportSlot()
    const transport = await slot.open(qr.entry, 'receiver')
    await slot.close()
    expect(qr.closed).not.toHaveBeenCalled()
    expect(transport.id).toBe('qr')
  })

  it('closes a transport that finished starting after the slot was closed', async () => {
    const nearby = entry('nearby')
    const slot = createTransportSlot()
    const opening = slot.open(nearby.entry, 'payer')
    await slot.close()
    await expect(opening).rejects.toThrow()
    expect(nearby.closed).toHaveBeenCalledTimes(1)
  })
})
