import { describe, expect, it, vi } from 'vitest'
import { createQrSurface } from './qr-surface'

describe('createQrSurface', () => {
  it('starts empty, holds what was presented and notifies on every change', () => {
    const surface = createQrSurface()
    const listener = vi.fn()
    surface.subscribe(listener)
    expect(surface.getSnapshot()).toBeNull()
    const texts = ['BP:A', 'BP:B']
    surface.present(texts)
    expect(surface.getSnapshot()).toBe(texts)
    expect(listener).toHaveBeenCalledTimes(1)
    surface.present(['BP:C'])
    expect(surface.getSnapshot()).toEqual(['BP:C'])
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('clears once: clearing an empty surface notifies nobody', () => {
    const surface = createQrSurface()
    const listener = vi.fn()
    surface.present(['BP:A'])
    surface.subscribe(listener)
    surface.clear()
    surface.clear()
    expect(surface.getSnapshot()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stops notifying a listener that unsubscribed', () => {
    const surface = createQrSurface()
    const listener = vi.fn()
    const stop = surface.subscribe(listener)
    stop()
    surface.present(['BP:A'])
    expect(listener).not.toHaveBeenCalled()
  })
})
