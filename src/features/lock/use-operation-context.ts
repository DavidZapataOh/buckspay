import { address } from '@solana/kit'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { useMemo } from 'react'
import { ACTIVE_PROFILE } from '../../protocol/active-profile'
import type { ActivationContext } from '../identity/activation'
import { BUILD_FUNDING_MINT } from './build-funding'
import { BUILD_GATEWAY } from './gateway'

const PROGRAM_ADDRESS = address(ACTIVE_PROFILE.programId)

export type OperationScreenContext = Omit<ActivationContext, 'rpc'> & {
  rpc: ReturnType<typeof useMobileWallet>['client']['rpc']
}

/** What the lock screens need to read the cluster, ask the wallet and reach the gateway. */
export function useOperationContext(): OperationScreenContext {
  const { client, getTransactionSigner, signTransactions } = useMobileWallet()
  return useMemo(
    () => ({
      rpc: client.rpc,
      getTransactionSigner,
      signTransactions,
      gateway: BUILD_GATEWAY,
      programAddress: PROGRAM_ADDRESS,
      windows: ACTIVE_PROFILE.windows,
      mint: BUILD_FUNDING_MINT,
    }),
    [client.rpc, getTransactionSigner, signTransactions],
  )
}
