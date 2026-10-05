import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { address, createNoopSigner, getAddressDecoder } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import vectors from '../../../anchor/crates/protocol/tests/vectors/v1.json'
import { dataLength, decodeIssue, decodeSpend, recordAddress, walkChain } from '../../protocol'
import { type NoteChain } from './chain'
import { reclaimInstructions, recordPrefixInstructions, SECP256R1_PROGRAM, settleInstructions } from './self-pay'

const program = hexToBytes(vectors.record_addresses.program_id)
const programAddress = getAddressDecoder().decode(program)
const pay = {
  payer: createNoopSigner(address('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS')),
  programAddress,
  noteDomain: hexToBytes(vectors.domain.note),
  reclaimDomain: hexToBytes(vectors.domain.reclaim),
  mint: address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
  tokenProgram: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  destination: address('11111111111111111111111111111112'),
}
const settlement = vectors.settlements.find(({ name }) => name === 'unbonded_receiver_settles')!
const chain: NoteChain = {
  issue: decodeIssue(hexToBytes(settlement.issue)),
  spends: settlement.spends.map((spend) => decodeSpend(hexToBytes(spend))),
}
const walk = walkChain(pay.noteDomain, chain.issue, chain.spends)
const recordsOf = (outputs: Uint8Array[]) =>
  outputs.map((output) => getAddressDecoder().decode(recordAddress(program, output)!))
const discriminator = (data: ArrayLike<number> | undefined) => Array.from(data ?? []).slice(0, 8)
describe('the transactions a wallet signs to settle a note itself', () => {
  it('verifies every signature of the chain and names the record of each consumed output', async () => {
    const [verify, settle] = await settleInstructions(pay, chain)
    expect(verify.programAddress).toBe(SECP256R1_PROGRAM)
    expect(verify.data).toHaveLength(dataLength(3))
    expect(settle.programAddress).toBe(programAddress)
    expect(discriminator(settle.data)).toEqual([21, 43, 198, 188, 252, 22, 228, 86])
    const accounts = settle.accounts ?? []
    expect(accounts).toHaveLength(9 + 2)
    expect(accounts.slice(9).map(({ address }) => address)).toEqual(
      recordsOf(walk.consumed.map(({ output }) => output)),
    )
    expect(accounts.slice(9).every(({ role }) => role === 1)).toBe(true)
    expect(accounts[4].address).toBe(pay.mint)
    expect(accounts[5].address).toBe(pay.destination)
    expect(accounts[6].address).toBe('Sysvar1nstructions1111111111111111111111111')
    expect(accounts[7].address).toBe(pay.tokenProgram)
  })

  it('leaves out the signatures that records on chain vouch for, and the verification when none is left', async () => {
    const [verify] = await settleInstructions(pay, chain, 1)
    expect(verify.data).toHaveLength(dataLength(2))
    const resumed = await settleInstructions(pay, chain, 3)
    expect(resumed).toHaveLength(1)
    expect(resumed[0].programAddress).toBe(programAddress)
  })

  it('settles a note issued to a terminal account through the record of the issue output', async () => {
    const direct = vectors.payments.find(({ name }) => name === 'direct_issue')!
    const alone: NoteChain = { issue: decodeIssue(hexToBytes(direct.issue)), spends: [] }
    const [verify, settle] = await settleInstructions(pay, alone)
    expect(verify.data).toHaveLength(dataLength(1))
    const only = walkChain(pay.noteDomain, alone.issue, []).last[0]
    expect((settle.accounts ?? []).slice(9).map(({ address }) => address)).toEqual(recordsOf([only.id]))
  })

  it('records the consumed outputs without paying, and needs a spend to record', async () => {
    const [verify, record] = await recordPrefixInstructions(pay, chain)
    expect(verify.data).toHaveLength(dataLength(3))
    expect(record.accounts ?? []).toHaveLength(4 + 2)
    expect(discriminator(record.data)).not.toEqual([21, 43, 198, 188, 252, 22, 228, 86])
    await expect(recordPrefixInstructions(pay, { ...chain, spends: [] })).rejects.toMatchObject({ code: 'Length' })
  })

  it('takes back an output with the owner’s signature in the verification, the device and the reclaimed record', async () => {
    const [payment] = vectors.payments
    const paid: NoteChain = {
      issue: decodeIssue(hexToBytes(payment.issue)),
      spends: payment.spends.slice(0, 1).map((spend) => decodeSpend(hexToBytes(spend))),
    }
    const [holder] = walkChain(pay.noteDomain, paid.issue, paid.spends).last
    if (holder.owner.type !== 'device') throw new Error('the first payment of the vector is to a device')
    const signature = new Uint8Array(64).fill(9)
    const [verify, reclaim] = await reclaimInstructions(pay, paid, holder.owner.key, 0, 1_900_000_000, signature)
    // The issue, the payment and the owner's reclaim.
    expect(verify.data).toHaveLength(dataLength(3))
    expect(bytesToHex((verify.data as Uint8Array).subarray(dataLength(3) - 96 - 64, dataLength(3) - 96))).toBe(
      bytesToHex(signature),
    )
    const accounts = reclaim.accounts ?? []
    expect(accounts).toHaveLength(10 + 2)
    expect(accounts.at(-1)?.address).toBe(recordsOf([holder.id])[0])
    // An output of a terminal account is nobody's to take back.
    await expect(reclaimInstructions(pay, chain, holder.owner.key, 0, 1, signature)).rejects.toMatchObject({
      code: 'Owner',
    })
  })
})
