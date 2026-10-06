import { address, getAddressEncoder } from '@solana/kit'
import { DEVNET_GENESIS_HASH, domain, MAINNET_GENESIS_HASH, Purpose } from '../protocol'
import { ACTIVE_PROFILE } from '../protocol/active-profile'

const GENESIS_HASH = { devnet: DEVNET_GENESIS_HASH, mainnet: MAINNET_GENESIS_HASH }

/** The program of this build and the domains its notes and tickets are signed under on `cluster`. */
export function paymentDomains(cluster: keyof typeof GENESIS_HASH) {
  const program = Uint8Array.from(getAddressEncoder().encode(address(ACTIVE_PROFILE.programId)))
  return {
    program,
    noteDomain: domain(Purpose.Note, GENESIS_HASH[cluster], program),
    ticketDomain: domain(Purpose.Ticket, GENESIS_HASH[cluster], program),
  }
}
