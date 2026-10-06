import { bytesToHex } from '@noble/hashes/utils.js'
import { getAddressEncoder } from '@solana/kit'
import type { Token } from '../../payment/preflight'
import { BUILD_FUNDING_MINT } from '../lock/build-funding'
import { FUNDING_SYMBOL } from '../lock/lock-copy'

/** The token of this build: the mint that funds locks, with the decimals USDC has. */
export const BUILD_TOKEN: Token = { symbol: FUNDING_SYMBOL, decimals: 6 }

export const BUILD_MINT_BYTES = Uint8Array.from(getAddressEncoder().encode(BUILD_FUNDING_MINT))

/** Hex of the mint to its token: the one a request may name. */
export const BUILD_TOKENS: ReadonlyMap<string, Token> = new Map([[bytesToHex(BUILD_MINT_BYTES), BUILD_TOKEN]])
