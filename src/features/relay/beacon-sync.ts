import { pinnedKey } from '../../protocol/hpke'
import { shouldAdvertiseOnline } from '../mesh/beacon'
import type { MeshNative } from '../mesh/native'
import type { NoteDb } from '../notes/db'
import { loadConfig, refreshConfig } from './config'

type Deps = {
  db: NoteDb
  native: Pick<MeshNative, 'status' | 'setBeacon'>
  genesisHash: Uint8Array
  /** `/v1/hpke-config`, as the gateway answers it. */
  fetchConfig: () => Promise<{ keys: { keyId: number; publicKey: string }[] }>
  now: () => number
}

/**
 * Keeps what this phone tells the air in line with what it can do: online only with validated internet and a gateway
 * configuration fetched in the last day, a carrier otherwise. The configuration is fetched when it is older than that and the internet works.
 */
export async function syncBeacon({ db, native, genesisHash, fetchConfig, now }: Deps): Promise<boolean> {
  const { validated } = await native.status()
  let config = await loadConfig(db)
  if (validated && (!config || !shouldAdvertiseOnline({ validated }, config, now()))) {
    config = await refreshConfig(db, fetchConfig, now()).catch(() => config)
  }
  const key = pinnedKey(config, now())
  const online = key !== null && shouldAdvertiseOnline({ validated }, config, now())
  // A phone without internet still says so: its beacon is how a payer finds a carrier.
  await native.setBeacon(online, genesisHash.slice(0, 4), key?.keyId ?? 0)
  return online
}
