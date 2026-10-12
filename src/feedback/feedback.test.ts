import { describe, expect, it, vi } from 'vitest'
import { createFeedback } from './feedback'

function outputs() {
  return { vibrate: vi.fn(), play: vi.fn() }
}

describe('answering an action with touch and sound', () => {
  it('does both for every cue by default', () => {
    const out = outputs()
    const feedback = createFeedback(out)
    feedback.cue('success')
    expect(out.vibrate).toHaveBeenCalledWith('success')
    expect(out.play).toHaveBeenCalledWith('success')
  })

  it('stays silent when the person turned sound off, and still vibrates', () => {
    const out = outputs()
    const feedback = createFeedback(out)
    feedback.set({ sound: false, haptics: true })
    feedback.cue('tap')
    expect(out.play).not.toHaveBeenCalled()
    expect(out.vibrate).toHaveBeenCalledTimes(1)
  })

  it('does not vibrate when the person turned that off', () => {
    const out = outputs()
    const feedback = createFeedback(out)
    feedback.set({ sound: true, haptics: false })
    feedback.cue('problem')
    expect(out.vibrate).not.toHaveBeenCalled()
    expect(out.play).toHaveBeenCalledWith('problem')
  })

  it('never lets a failing speaker or motor break the screen that asked', () => {
    const feedback = createFeedback({
      vibrate: () => {
        throw new Error('no motor')
      },
      play: () => {
        throw new Error('no speaker')
      },
    })
    expect(() => feedback.cue('step')).not.toThrow()
  })
})
