import { getBase58Encoder } from '@solana/kit'

const base58 = getBase58Encoder()

export const MAINNET_GENESIS_HASH = Uint8Array.from(base58.encode('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'))
export const DEVNET_GENESIS_HASH = Uint8Array.from(base58.encode('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'))
