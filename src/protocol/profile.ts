import vectors from '../../anchor/crates/protocol/tests/vectors/v1.json'

export type ProfileName = 'production' | 'short'

/** The windows of the lock lifecycle in seconds, as the program of the profile enforces them. */
export type Windows = {
  grace: number
  challenge: number
  claimWindow: number
  minNoteLife: number
  releaseDelay: number
  rotationDelay: number
  /** A payment to a device expires at least this long before the output it spends. */
  expiryStep: number
}

export type Profile = { name: ProfileName; programId: string; windows: Windows }

/**
 * The profile a build is made for. The production program holds real users' locks; the short
 * profile has a program of its own whose windows are minutes, for checks that cannot wait for days.
 * A program id that is not the profile's is refused: signatures are bound to the program id, so the
 * two must never be mixed.
 */
export function resolveProfile({
  profile = 'production',
  programId,
  cluster = 'devnet',
}: {
  profile?: string
  programId?: string
  cluster?: string
}): Profile {
  const { production, short } = vectors.profiles
  if (profile !== 'production' && profile !== 'short') {
    throw new Error(`EXPO_PUBLIC_PROFILE must be production or short, not ${profile}.`)
  }
  if (profile === 'short' && cluster !== 'devnet') throw new Error('The short profile exists on devnet only.')
  const own = profile === 'short' ? short.programId : (production.programIds as Record<string, string | null>)[cluster]
  if (!own) throw new Error(`No program is deployed on ${cluster} for the ${profile} profile.`)
  if (programId !== undefined && programId !== own) {
    throw new Error(`EXPO_PUBLIC_PROGRAM_ID is not the program of the ${profile} profile (${own}).`)
  }
  return { name: profile, programId: own, windows: profile === 'short' ? short.windows : production.windows }
}

/** The shortest lock the program accepts, in seconds: the lock must outlast the windows around a note. */
export const minLockSeconds = ({ grace, challenge, minNoteLife }: Windows) => grace + challenge + minNoteLife
