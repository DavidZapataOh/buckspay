import type { Transport } from '../../transport/types'
import type { PairingRole, TransportEntry } from './registry'

type Held = { id: TransportEntry['id']; transport: Transport }

/** The QR transport stays open: its screen owns it. */
const release = async (held?: Held) => {
  if (held && held.id !== 'qr') await held.transport.close()
}

/**
 * The transport of the payment on screen. Each payment starts its own (a Nearby link is never reused), and
 * the previous one is closed first.
 */
export function createTransportSlot() {
  let current: Held | undefined
  let generation = 0

  function detach() {
    generation++
    const held = current
    current = undefined
    return held
  }

  return {
    close: () => release(detach()),
    async open(entry: TransportEntry, role: PairingRole): Promise<Transport> {
      const previous = detach()
      const mine = generation
      await release(previous)
      const transport = await entry.start(role)
      if (mine !== generation) {
        await release({ id: entry.id, transport })
        throw new Error('The payment ended before the transport was ready')
      }
      current = { id: entry.id, transport }
      return transport
    },
  }
}
