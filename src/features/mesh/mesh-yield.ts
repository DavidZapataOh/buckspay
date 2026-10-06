import { meshNative } from '../mesh/native'

/** The mesh stops scanning and advertising while a Nearby link is open, so the radio serves one thing at a time. */
export async function meshPause(): Promise<void> {
  await meshNative.pause().catch(() => {})
}

export async function meshResume(): Promise<void> {
  await meshNative.resume().catch(() => {})
}
