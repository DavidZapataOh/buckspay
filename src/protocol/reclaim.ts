import { checkU32, Kind, VERSION } from './codec'
import { content, envelope } from './hash'

/** `ver ‖ kind ‖ deadline:u32 LE`: the last second at which the signature may be used. */
export function reclaimBody(deadline: number): Uint8Array {
  checkU32(deadline)
  const body = new Uint8Array(6)
  body[0] = VERSION
  body[1] = Kind.Reclaim
  new DataView(body.buffer).setUint32(2, deadline, true)
  return body
}

/**
 * `DOMAIN(reclaim) ‖ output id ‖ SHA-256(body)`, the message the owner of `output` signs to take it
 * back once nobody settled it in time. It names no destination: the program pays the wallet the
 * signing key is bound to.
 */
export const reclaimEnvelope = (domain: Uint8Array, output: Uint8Array, deadline: number) =>
  envelope(domain, output, content(reclaimBody(deadline)))

/** What a reclaim leaves in the record of the output it takes back: the same for every reclaim. */
export const recordContent = () => content(Uint8Array.of(VERSION, Kind.Reclaim))
