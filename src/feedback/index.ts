import { deviceOutputs } from './device'
import { createFeedback } from './feedback'

export type { Cue } from './feedback'
export { loadFeedbackPreferences, saveFeedbackPreferences } from './preferences'

/** The one place the app answers an action: `feedback.cue('success')`. */
export const feedback = createFeedback(deviceOutputs)
