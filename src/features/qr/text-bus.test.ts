import { describe, expect, it, vi } from 'vitest'
import { createTextBus } from './text-bus'

describe('createTextBus', () => {
  it('delivers a pushed text to every current subscriber', () => {
    const bus = createTextBus()
    const a = vi.fn()
    const b = vi.fn()
    bus.source.subscribe(a)
    bus.source.subscribe(b)
    bus.push('BP:1')
    expect(a).toHaveBeenCalledWith('BP:1')
    expect(b).toHaveBeenCalledWith('BP:1')
  })

  it('does not replay a text to a subscriber that arrives later', () => {
    const bus = createTextBus()
    bus.push('BP:old')
    const late = vi.fn()
    bus.source.subscribe(late)
    expect(late).not.toHaveBeenCalled()
  })

  it('stops delivering after unsubscribe, even while a push is running', () => {
    const bus = createTextBus()
    const second = vi.fn()
    let stopSecond = () => {}
    bus.source.subscribe(() => stopSecond())
    stopSecond = bus.source.subscribe(second)
    bus.push('BP:1')
    bus.push('BP:2')
    expect(second).toHaveBeenCalledTimes(1)
  })
})
