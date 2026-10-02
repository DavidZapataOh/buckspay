import { hexToBytes } from '@noble/hashes/utils.js'
import { findDevicePda } from '@project/anchor'
import { address, getBase64Decoder } from '@solana/kit'
import { describe, expect, it, vi } from 'vitest'
import fixture from '../../../gateway/tests/fixtures/registration.json'
import { buildSponsoredTransaction } from './register-device'

vi.mock('../../../modules/hardware-keys/src/HardwareKeysModule', () => import('../../keys/test-support/hardware-keys'))

describe('sponsored registration', () => {
  it('is byte for byte the message the gateway builds', async () => {
    const key = hexToBytes(fixture.device)
    const [device, bump] = await findDevicePda(key)
    const transaction = buildSponsoredTransaction(
      {
        binding: { key, signature: hexToBytes(fixture.signature), envelope: hexToBytes(fixture.envelope) },
        bump,
        device,
        wallet: address(fixture.wallet),
      },
      {
        feePayer: address(fixture.feePayer),
        blockhash: fixture.blockhash,
        lastValidBlockHeight: 0n,
        computeUnitPrice: BigInt(fixture.computeUnitPrice),
      },
    )
    expect(getBase64Decoder().decode(transaction.messageBytes)).toBe(fixture.message)
  })
})
