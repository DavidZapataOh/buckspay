import { startHub, joinHub, type GroupWire } from '../../transport/nearby/group'
import { nearbyNative } from '../../transport/nearby/native'
import { meshPause, meshResume } from '../transport/mesh-yield'
import { type Invite, sessionTag } from './channel'

/** Failed spoke connections before the screen offers "Connect one at a time". */
export const GROUP_FALLBACK_AFTER = 2

/** Hands the radio to the group wire and gives it back to the mesh when the wire closes or never opened. */
async function withMeshPaused(open: () => Promise<GroupWire>): Promise<GroupWire> {
  await meshPause()
  let wire: GroupWire
  try {
    wire = await open()
  } catch (error) {
    await meshResume()
    throw error
  }
  const close = wire.close.bind(wire)
  let resumed = false
  wire.close = async () => {
    try {
      await close()
    } finally {
      if (!resumed) {
        resumed = true
        await meshResume()
      }
    }
  }
  return wire
}

export const openHub = (invite: Invite): Promise<GroupWire> =>
  withMeshPaused(() => startHub(nearbyNative, { tag: sessionTag(invite) }))

export const openSpoke = (invite: Invite, signal?: AbortSignal): Promise<GroupWire> =>
  withMeshPaused(() => joinHub(nearbyNative, { tag: sessionTag(invite), signal }))
