import { router } from 'expo-router'
import { markPermissionsSeen } from '../features/mesh/first-open'
import { meshNative, requestMeshPermissions } from '../features/mesh/native'
import { PermissionsScreen } from '../features/mesh/permissions-screen'

export default function Permissions() {
  async function done({ mesh }: { mesh: boolean }) {
    await markPermissionsSeen()
    if (mesh) await meshNative.start().catch(() => {})
    router.replace('/')
  }
  return <PermissionsScreen request={requestMeshPermissions} onDone={(result) => void done(result)} />
}
