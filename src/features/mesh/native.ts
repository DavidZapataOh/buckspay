import { PermissionsAndroid, type Permission } from 'react-native'
import Mesh, { type MeshStatus, type MeshSupport } from '../../../modules/mesh/src/MeshModule'
import type { L2capLink } from '../relay/handoff'
import type { Channel } from '../relay/hop'

export type { MeshStatus, MeshSupport }
export type MeshStartError = 'permission-denied' | 'bluetooth-off' | 'unsupported'
export type PermissionGroup = 'nearby' | 'notifications'

export interface MeshNative {
  support(): Promise<MeshSupport>
  start(): Promise<void>
  stop(): Promise<void>
  /** Stops advertising and scanning while a Nearby link is open. */
  pause(): Promise<void>
  resume(): Promise<void>
  advertise(frameId: string, frame: Uint8Array, ttlSeconds: number): Promise<void>
  withdraw(frameId: string): Promise<void>
  status(): Promise<MeshStatus>
  setBeacon(online: boolean, clusterTag: Uint8Array, keyId: number): Promise<void>
  clearBeacon(): Promise<void>
}

/** The only file that binds the mesh module. */
export const meshNative: MeshNative = Mesh

/** A channel the service holds for JavaScript, by the id the module gave it. */
export const channelOf = (id: number): Channel => ({
  read: async (length, timeoutMs) => new Uint8Array(await Mesh.l2capRead(id, length, timeoutMs)),
  write: (bytes) => Mesh.l2capWrite(id, bytes),
  close: () => void Mesh.l2capClose(id).catch(() => {}),
})

export const l2capLink: L2capLink = {
  listen: async () => (await Mesh.status()).psm,
  connect: async (address, psm) => channelOf(await Mesh.l2capConnect(address, psm)),
}

const GROUPS: Record<PermissionGroup, Permission[]> = {
  nearby: [
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
  ],
  notifications: [PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS],
}

/** Asks for the groups together; the answer says whether the Bluetooth permissions the mesh needs were granted. */
export async function requestMeshPermissions(groups: readonly PermissionGroup[]): Promise<'granted' | 'denied'> {
  const answers = await PermissionsAndroid.requestMultiple(groups.flatMap((group) => GROUPS[group]))
  return GROUPS.nearby.every((permission) => answers[permission] === PermissionsAndroid.RESULTS.GRANTED)
    ? 'granted'
    : 'denied'
}
