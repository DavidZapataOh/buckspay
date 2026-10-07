import { address } from '@solana/kit'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { useEffect, useState } from 'react'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { loadTickets } from '../attesters/tickets'
import { BUILD_FUNDING_MINT } from '../lock/build-funding'
import { ACTIVE_PROFILE } from '../../protocol/active-profile'
import { loadMintTerms, type MintTerms, readMintTerms, saveMintTerms, tipTerms } from './reward-terms'
import { type TipTerms, usePaywordSigner } from './seams'

const PROGRAM_ADDRESS = address(ACTIVE_PROFILE.programId)

/**
 * The terms of a tip, from what is stored first: the mint's terms as last read and the bonds of the tickets the phone
 * holds, so they show offline. The mint is read again in the background; a failed read keeps what is shown. Absent
 * until the mint was read once, and while a word cannot be signed.
 */
export function useTipTerms(): TipTerms | undefined {
  const { client } = useMobileWallet()
  const { deviceKey } = useDeviceIdentity()
  const signer = usePaywordSigner()
  const [mint, setMint] = useState<MintTerms>()
  const [bonds, setBonds] = useState<readonly bigint[]>([])
  const key = deviceKey?.publicKey
  const rpc = client.rpc

  useEffect(() => {
    let current = true
    void loadMintTerms().then((stored) => current && stored && setMint((shown) => shown ?? stored))
    readMintTerms(rpc, PROGRAM_ADDRESS, BUILD_FUNDING_MINT).then(
      async (read) => {
        await saveMintTerms(read)
        if (current) setMint(read)
      },
      (failure: unknown) => console.warn('The reward mint was not read; showing the stored terms', failure),
    )
    return () => {
      current = false
    }
  }, [rpc])

  useEffect(() => {
    if (!key) return
    let current = true
    void loadTickets(key).then((tickets) => {
      if (current) setBonds([...tickets.values()].map((ticket) => ticket.bond))
    })
    return () => {
      current = false
    }
  }, [key])

  return tipTerms(mint, bonds, signer !== undefined)
}
