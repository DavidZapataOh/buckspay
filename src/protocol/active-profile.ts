import { resolveProfile } from './profile'

/**
 * The profile of this build, read from its environment when the bundle starts: a build whose
 * profile and program id disagree does not run.
 */
export const ACTIVE_PROFILE = resolveProfile({
  profile: process.env.EXPO_PUBLIC_PROFILE,
  programId: process.env.EXPO_PUBLIC_PROGRAM_ID,
})
