import { type Address, getAddressDecoder, getAddressEncoder } from '@solana/kit'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { useEffect, useState } from 'react'
import { Share } from 'react-native'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { BUILD_FUNDING_MINT } from '../lock/build-funding'
import { createTokenAccount } from './create-token-account'
import { tokenAccountExists, tokenAccountOf } from './token-account'

/** The wallet's own side of Far away: whether its USDC account exists, creating it with the wallet, and sharing the link. */
export function useFarAwayReceive() {
  const { device } = useDeviceIdentity()
  const { client, getTransactionSigner } = useMobileWallet()
  const [tokenAccount, setTokenAccount] = useState<'exists' | 'missing' | 'checking'>('checking')
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)
  const wallet = device?.wallet
  const walletBytes = wallet ? Uint8Array.from(getAddressEncoder().encode(wallet)) : undefined
  const mintBytes = Uint8Array.from(getAddressEncoder().encode(BUILD_FUNDING_MINT))

  useEffect(() => {
    if (!walletBytes) return
    let current = true
    void tokenAccountExists(client.rpc, walletBytes, mintBytes).then(
      (exists) => current && setTokenAccount(exists ? 'exists' : 'missing'),
      () => current && setTokenAccount('missing'),
    )
    return () => {
      current = false
    }
    // The bytes are derived from the wallet and the build's mint; a new `version` asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, client.rpc, version])

  async function create() {
    if (!wallet || !walletBytes) return
    setBusy(true)
    try {
      const { owner } = await tokenAccountOf(client.rpc, walletBytes, mintBytes)
      await createTokenAccount(client.rpc, getTransactionSigner, wallet, BUILD_FUNDING_MINT, owner)
    } catch {
      // The wallet was closed or the network refused: the next check tells what is true.
    } finally {
      setBusy(false)
      setTokenAccount('checking')
      setVersion((v) => v + 1)
    }
  }

  return {
    wallet: walletBytes,
    mint: mintBytes,
    tokenAccount,
    busy,
    create,
    share: (message: string) => void Share.share({ message }),
  }
}

export const addressOf = (bytes: Uint8Array): Address => getAddressDecoder().decode(bytes)
