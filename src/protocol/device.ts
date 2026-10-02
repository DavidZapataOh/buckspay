import { concatBytes } from '@noble/hashes/utils.js'
import { checkBytes, Kind, ProtocolError, VERSION } from './codec'
import { content, envelope } from './hash'

/** `ver ‖ kind ‖ wallet[32] ‖ key[33]`: the device key consents to being bound to `wallet`. */
export function deviceBindingBody(wallet: Uint8Array, key: Uint8Array): Uint8Array {
  checkBytes(wallet, 32)
  checkBytes(key, 33)
  if (key[0] !== 0x02 && key[0] !== 0x03) throw new ProtocolError('Owner')
  return concatBytes(Uint8Array.of(VERSION, Kind.DeviceBinding), wallet, key)
}

/** `DOMAIN(device) ‖ wallet ‖ SHA-256(body)`, the message the device key signs. */
export const deviceBindingEnvelope = (domainDevice: Uint8Array, wallet: Uint8Array, key: Uint8Array) =>
  envelope(domainDevice, wallet, content(deviceBindingBody(wallet, key)))
