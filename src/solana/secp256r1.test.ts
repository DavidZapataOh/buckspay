import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import fixture from '../../anchor/programs/buckspay/tests/fixtures/secp256r1.json'
import { getSecp256r1VerifyInstruction, SECP256R1_PROGRAM_ADDRESS } from './secp256r1'

const input = {
  publicKey: hexToBytes(fixture.device),
  signature: hexToBytes(fixture.signature),
  message: hexToBytes(fixture.message),
}

describe('secp256r1 verification instruction', () => {
  it('encodes exactly what the Rust SDK builder encodes', () => {
    const instruction = getSecp256r1VerifyInstruction(input)
    expect(instruction.programAddress).toBe(SECP256R1_PROGRAM_ADDRESS)
    expect(instruction.accounts).toBeUndefined()
    expect(bytesToHex(Uint8Array.from(instruction.data))).toBe(fixture.data)
  })

  it('rejects a key or signature of the wrong length', () => {
    expect(() => getSecp256r1VerifyInstruction({ ...input, publicKey: input.publicKey.subarray(1) })).toThrow(
      'publicKey must be 33 bytes',
    )
    expect(() => getSecp256r1VerifyInstruction({ ...input, signature: input.signature.subarray(1) })).toThrow(
      'signature must be 64 bytes',
    )
  })
})
