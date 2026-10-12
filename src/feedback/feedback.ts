import { DEFAULT_PREFS, type FeedbackPrefs } from './preferences'

export type Cue = 'tap' | 'step' | 'success' | 'problem'

export type Outputs = { vibrate: (cue: Cue) => void; play: (cue: Cue) => void }

/** Answers an action with touch and sound, as the person allowed; a broken speaker or motor never reaches the screen. */
export function createFeedback(outputs: Outputs, initial: FeedbackPrefs = DEFAULT_PREFS) {
  let prefs = initial
  const attempt = (output: (cue: Cue) => void, cue: Cue) => {
    try {
      output(cue)
    } catch {
      // The answer is a courtesy; the action it follows already happened.
    }
  }
  return {
    set(next: FeedbackPrefs) {
      prefs = next
    },
    get: () => prefs,
    cue(cue: Cue) {
      if (prefs.haptics) attempt(outputs.vibrate, cue)
      if (prefs.sound) attempt(outputs.play, cue)
    },
  }
}
