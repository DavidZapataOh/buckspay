import { address } from '@solana/kit'

const mint = process.env.EXPO_PUBLIC_FUNDING_MINT
if (!mint) throw new Error('EXPO_PUBLIC_FUNDING_MINT is not set.')

/** The token that funds locks, fixed when the bundle is made: the same mint the gateway is configured with. */
export const BUILD_FUNDING_MINT = address(mint)
