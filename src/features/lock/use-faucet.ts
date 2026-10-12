import type { Address } from '@solana/kit'
import { useMemo } from 'react'
import { BUILD_GATEWAY } from './gateway'
import { readFunding } from './funding'
import { useOperationContext } from './use-operation-context'

/** What the form that adds funds needs to offer test money to `wallet`: the faucet of this build's gateway, and a way to read the wallet. */
export function useFaucet(wallet: Address | undefined) {
  const ctx = useOperationContext()
  return useMemo(
    () =>
      wallet && BUILD_GATEWAY
        ? {
            wallet: String(wallet),
            gateway: BUILD_GATEWAY,
            read: async () => (await readFunding(ctx.rpc, wallet, ctx.mint)).balance,
          }
        : undefined,
    [wallet, ctx.rpc, ctx.mint],
  )
}
