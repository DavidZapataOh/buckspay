import {
  address,
  fixEncoderSize,
  getBytesEncoder,
  getStructEncoder,
  getU16Encoder,
  getU8Encoder,
  type Instruction,
  type InstructionWithData,
  type ReadonlyUint8Array,
} from '@solana/kit'

export const SECP256R1_PROGRAM_ADDRESS = address('Secp256r1SigVerify1111111111111111111111111')

const HEADER_SIZE = 16
const PUBLIC_KEY_SIZE = 33
const SIGNATURE_SIZE = 64
const INLINE = 0xffff

const encoder = getStructEncoder([
  ['numSignatures', getU8Encoder()],
  ['padding', getU8Encoder()],
  ['signatureOffset', getU16Encoder()],
  ['signatureInstructionIndex', getU16Encoder()],
  ['publicKeyOffset', getU16Encoder()],
  ['publicKeyInstructionIndex', getU16Encoder()],
  ['messageDataOffset', getU16Encoder()],
  ['messageDataSize', getU16Encoder()],
  ['messageInstructionIndex', getU16Encoder()],
  ['publicKey', fixEncoderSize(getBytesEncoder(), PUBLIC_KEY_SIZE)],
  ['signature', fixEncoderSize(getBytesEncoder(), SIGNATURE_SIZE)],
  ['message', getBytesEncoder()],
])

/** One inline secp256r1 verification: compressed key, low-S `r‖s`, message. */
export function getSecp256r1VerifyInstruction(input: {
  publicKey: ReadonlyUint8Array
  signature: ReadonlyUint8Array
  message: ReadonlyUint8Array
}): Instruction<typeof SECP256R1_PROGRAM_ADDRESS> & InstructionWithData<ReadonlyUint8Array> {
  if (input.publicKey.length !== PUBLIC_KEY_SIZE) throw new Error('publicKey must be 33 bytes')
  if (input.signature.length !== SIGNATURE_SIZE) throw new Error('signature must be 64 bytes')
  const signatureOffset = HEADER_SIZE + PUBLIC_KEY_SIZE
  const messageDataOffset = signatureOffset + SIGNATURE_SIZE
  if (messageDataOffset + input.message.length > INLINE) throw new Error('message too long')
  const data = encoder.encode({
    numSignatures: 1,
    padding: 0,
    signatureOffset,
    signatureInstructionIndex: INLINE,
    publicKeyOffset: HEADER_SIZE,
    publicKeyInstructionIndex: INLINE,
    messageDataOffset,
    messageDataSize: input.message.length,
    messageInstructionIndex: INLINE,
    ...input,
  })
  return Object.freeze({ programAddress: SECP256R1_PROGRAM_ADDRESS, data })
}
