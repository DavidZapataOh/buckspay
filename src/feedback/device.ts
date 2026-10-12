import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio'
import * as Haptics from 'expo-haptics'
import type { Cue, Outputs } from './feedback'

const sources: Record<Cue, number> = {
  tap: require('../../assets/sounds/tap.wav'),
  step: require('../../assets/sounds/step.wav'),
  success: require('../../assets/sounds/success.wav'),
  problem: require('../../assets/sounds/problem.wav'),
}

const players = new Map<Cue, AudioPlayer>()
let configured = false

function player(cue: Cue) {
  if (!configured) {
    configured = true
    void setAudioModeAsync({ playsInSilentMode: false, interruptionMode: 'mixWithOthers' })
  }
  let found = players.get(cue)
  if (!found) {
    found = createAudioPlayer(sources[cue])
    players.set(cue, found)
  }
  return found
}

/** The phone's motor and speaker: sound follows the silent switch and mixes with whatever else is playing. */
export const deviceOutputs: Outputs = {
  vibrate(cue) {
    if (cue === 'tap') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    else if (cue === 'step') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    else if (cue === 'success') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
    else void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
  },
  play(cue) {
    const sound = player(cue)
    void sound.seekTo(0).then(() => sound.play())
  },
}
