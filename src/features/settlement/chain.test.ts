import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import vectors from '../../../anchor/crates/protocol/tests/vectors/v1.json'
import { decodeIssue, decodeSpend } from '../../protocol'
import { reclaimRequest, settlementRequest } from './chain'

const vector = vectors.settlements.find(({ name }) => name === 'unbonded_receiver_settles')!
const chain = {
  issue: decodeIssue(hexToBytes(vector.issue)),
  spends: vector.spends.map((spend) => decodeSpend(hexToBytes(spend))),
}

describe('the requests of a chain', () => {
  it('sends the issue and the spends in the wire formats of the protocol', () => {
    expect(settlementRequest(chain)).toEqual({ issue: vector.issue, spends: vector.spends })
  })

  it('adds the owner, the output, the deadline and the signature to a reclaim', () => {
    const owner = new Uint8Array(33).fill(2)
    const signature = new Uint8Array(64).fill(7)
    expect(reclaimRequest(chain, owner, 1, 1_900_000_000, signature)).toEqual({
      issue: vector.issue,
      spends: vector.spends,
      owner: bytesToHex(owner),
      which: 1,
      deadline: 1_900_000_000,
      signature: bytesToHex(signature),
    })
  })
})
