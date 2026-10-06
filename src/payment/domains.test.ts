import { getAddressEncoder } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import { DEVNET_GENESIS_HASH, domain, MAINNET_GENESIS_HASH, Purpose } from '../protocol'
import { ACTIVE_PROFILE } from '../protocol/active-profile'
import { paymentDomains } from './domains'

const program = Uint8Array.from(getAddressEncoder().encode(ACTIVE_PROFILE.programId as never))

describe('paymentDomains', () => {
  it('are the domains the device key signs under, for the program built into the app', () => {
    const devnet = paymentDomains('devnet')
    expect(devnet.program).toEqual(program)
    expect(devnet.noteDomain).toEqual(domain(Purpose.Note, DEVNET_GENESIS_HASH, program))
    expect(devnet.ticketDomain).toEqual(domain(Purpose.Ticket, DEVNET_GENESIS_HASH, program))
  })

  it('differ between clusters and between purposes', () => {
    const [devnet, mainnet] = [paymentDomains('devnet'), paymentDomains('mainnet')]
    expect(mainnet.noteDomain).toEqual(domain(Purpose.Note, MAINNET_GENESIS_HASH, program))
    expect(mainnet.noteDomain).not.toEqual(devnet.noteDomain)
    expect(devnet.noteDomain).not.toEqual(devnet.ticketDomain)
  })
})
