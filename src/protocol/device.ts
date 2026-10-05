import { concatBytes } from '@noble/hashes/utils.js'
import { checkBytes, checkU32, Kind, ProtocolError, VERSION } from './codec'
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

/**
 * `ver ‖ kind ‖ old_wallet[32] ‖ new_wallet[32] ‖ key[33] ‖ rotations:u32 LE`: the device key consents
 * to moving its binding from `oldWallet` to `newWallet` as the device's `rotations`-th rotation.
 */
export function deviceRotationBody(
  oldWallet: Uint8Array,
  newWallet: Uint8Array,
  key: Uint8Array,
  rotations: number,
): Uint8Array {
  checkBytes(oldWallet, 32)
  checkBytes(newWallet, 32)
  checkBytes(key, 33)
  checkU32(rotations)
  if (key[0] !== 0x02 && key[0] !== 0x03) throw new ProtocolError('Owner')
  const counter = new Uint8Array(4)
  new DataView(counter.buffer).setUint32(0, rotations, true)
  return concatBytes(Uint8Array.of(VERSION, Kind.Rotation), oldWallet, newWallet, key, counter)
}

/** `DOMAIN(device) ‖ old_wallet ‖ SHA-256(body)`: the slot is the wallet being replaced. */
export const deviceRotationEnvelope = (
  domainDevice: Uint8Array,
  oldWallet: Uint8Array,
  newWallet: Uint8Array,
  key: Uint8Array,
  rotations: number,
) => envelope(domainDevice, oldWallet, content(deviceRotationBody(oldWallet, newWallet, key, rotations)))
