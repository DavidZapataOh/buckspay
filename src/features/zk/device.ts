import type { Address, GetAccountInfoApi, Rpc } from '@solana/kit'
import { Platform } from 'react-native'
import type { NoteDb } from '../notes/db'
import type { PrivateGateway } from '../lock/gateway'
import type { SettlementDeps } from '../settlement/settle-held'
import { proverNative } from './native'
import { BUILD_PINS } from './pins'
import { createPrivateSettler } from './private-settler'
import { createKeyResolver, readChainKeys } from './trusted-key'

/** The private route of this phone: the prover module, the keys the program vouches for and the gateway. */
export function createDevicePrivateRoute(deps: {
  db: NoteDb
  gateway: PrivateGateway
  rpc: Rpc<GetAccountInfoApi>
  programAddress: Address
  noteDomain: Uint8Array
  now: () => number
  asked: Set<string>
}): SettlementDeps['private'] {
  if (Platform.OS !== 'android') return undefined
  const trustedKey = createKeyResolver({
    zkConfig: () => deps.gateway.zkConfig(),
    readChain: () => readChainKeys(deps.rpc, deps.programAddress),
    pins: BUILD_PINS,
    now: deps.now,
  })
  const settler = createPrivateSettler({
    db: deps.db,
    prover: proverNative,
    gateway: deps.gateway,
    trustedKey,
    noteDomain: deps.noteDomain,
    now: deps.now,
  })
  return { settler, userAsked: (id) => deps.asked.has(id) }
}
