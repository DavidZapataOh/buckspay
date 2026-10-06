import { pinnedKey } from '../../protocol/hpke'
import { shouldAdvertiseOnline } from '../mesh/beacon'
import type { MeshNative } from '../mesh/native'
import type { NoteDb } from '../notes/db'
import { loadConfig, refreshConfig } from './config'

type Deps = {
  db: NoteDb
  native: Pick<MeshNative, 'status' | 'setBeacon' | 'clearBeacon'>
  genesisHash: Uint8Array
  /** `/v1/hpke-config`, as the gateway answers it. */
  fetchConfig: () => Promise<{ keys: { keyId: number; publicKey: string }[] }>
  now: () => number
}

/**
 * Keeps what this phone tells the air in line with what it can do: online only with validated internet and a gateway
 * configuration fetched in the last day. The configuration is fetched when it is older than that and the internet works.
 */
export async function syncBeacon({ db, native, genesisHash, fetchConfig, now }: Deps): Promise<boolean> {
  const { validated } = await native.status()
  let config = await loadConfig(db)
  if (validated && (!config || !shouldAdvertiseOnline({ validated }, config, now()))) {
    config = await refreshConfig(db, fetchConfig, now()).catch(() => config)
  }
  const key = pinnedKey(config, now())
  const online = key !== null && shouldAdvertiseOnline({ validated }, config, now())
  if (online) await native.setBeacon(true, genesisHash.slice(0, 4), key.keyId)
  else await native.clearBeacon()
  return online
}
