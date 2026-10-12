import { act } from 'react'
import { create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { feedback, loadFeedbackPreferences } from '../../feedback'
import { resetAsyncStorage } from '../../test-support/async-storage'
import { FeedbackSetting } from './feedback-setting'

vi.mock('uniwind', () => ({ useCSSVariable: () => '#123456' }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  resetAsyncStorage()
  feedback.set({ sound: true, haptics: true })
})

async function show() {
  const { root } = await act(async () => create(<FeedbackSetting />))
  return root.findAllByType('Switch' as never)
}

describe('the sound and vibration setting', () => {
  it('has a switch for each, on by default, named in a word', async () => {
    const [sound, haptics] = await show()
    expect([sound.props.accessibilityLabel, sound.props.value]).toEqual(['Sound', true])
    expect([haptics.props.accessibilityLabel, haptics.props.value]).toEqual(['Vibration', true])
  })

  it('turns sound off for the whole app and remembers it', async () => {
    const [sound] = await show()
    await act(async () => sound.props.onValueChange(false))
    expect(feedback.get()).toEqual({ sound: false, haptics: true })
    expect(await loadFeedbackPreferences()).toEqual({ sound: false, haptics: true })
    expect((await show())[0].props.value).toBe(false)
  })

  it('turns vibration off on its own', async () => {
    const [, haptics] = await show()
    await act(async () => haptics.props.onValueChange(false))
    expect(feedback.get()).toEqual({ sound: true, haptics: false })
  })
})
