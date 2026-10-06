import { describe, expect, it } from 'vitest'
import { decodeInvite, decodePairing, encodeInvite, encodePairing } from './payloads'

const invite = {
  eventId: new Uint8Array(16).fill(1),
  authority: new Uint8Array(32).fill(2),
  name: 'Feria',
  endsAt: 1_800_100_000,
}
const pairing = { ...invite, eventSecret: new Uint8Array(32).fill(3), issuers: [new Uint8Array(33).fill(4)] }

describe('event payloads', () => {
  it('round-trips an invite and a pairing', () => {
    expect(decodeInvite(encodeInvite(invite))).toEqual(invite)
    expect(decodePairing(encodePairing(pairing))).toEqual(pairing)
  })

  it('an invite never carries the secret', () => {
    expect(encodeInvite(invite).length).toBe(1 + 16 + 32 + 4 + 1 + 5)
  })

  it('refuses unknown versions, long names and more than eight issuers', () => {
    const bad = encodeInvite(invite)
    bad[0] = 2
    expect(() => decodeInvite(bad)).toThrow()
    expect(() => encodeInvite({ ...invite, name: 'x'.repeat(49) })).toThrow()
    expect(() => encodePairing({ ...pairing, issuers: Array(9).fill(pairing.issuers[0]) })).toThrow()
    expect(() => encodePairing({ ...pairing, issuers: [] })).toThrow()
  })

  it('refuses truncated or padded bytes', () => {
    const wire = encodePairing(pairing)
    expect(() => decodePairing(wire.slice(0, -1))).toThrow()
    expect(() => decodePairing(new Uint8Array([...wire, 0]))).toThrow()
    expect(() => decodeInvite(encodeInvite(invite).slice(0, 10))).toThrow()
  })

  it('writes the name the way memos are written', () => {
    expect(decodeInvite(encodeInvite({ ...invite, name: '  Feria \n de  Cali ' })).name).toBe('Feria de Cali')
  })
})
