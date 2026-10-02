import { p256 } from '@noble/curves/nist.js'
import { equalBytes, hexToBytes } from '@noble/curves/utils.js'
import { ProtocolError } from '../protocol'

const N = p256.Point.Fn.ORDER
const SPKI_P256_PREFIX = hexToBytes('3059301306072a8648ce3d020106082a8648ce3d030107034200')

export function sec1FromSpki(spki: Uint8Array): Uint8Array {
  if (spki.length !== 91 || !equalBytes(spki.subarray(0, 26), SPKI_P256_PREFIX)) throw new ProtocolError('Signer')
  try {
    return p256.Point.fromBytes(spki.subarray(26)).toBytes(true)
  } catch {
    throw new ProtocolError('Signer')
  }
}

export function compactLowS(der: Uint8Array): Uint8Array {
  let signature
  try {
    signature = p256.Signature.fromBytes(der, 'der')
  } catch {
    throw new ProtocolError('Signature')
  }
  return new p256.Signature(signature.r, signature.hasHighS() ? N - signature.s : signature.s).toBytes('compact')
}
