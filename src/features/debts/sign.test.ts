import { p256 } from '@noble/curves/nist.js'
import { BUCKSPAY_PROGRAM_ADDRESS } from '@project/anchor'
import { getAddressEncoder } from '@solana/kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  content,
  DEVNET_GENESIS_HASH,
  domain,
  encodeIou,
  encodeJoin,
  encodeStatement,
  envelope,
  type Iou,
  IouCause,
  iouEnvelope,
  joinSlot,
  MAINNET_GENESIS_HASH,
  Purpose,
  verifySignature,
} from '../../protocol'
import { configureDeviceKey, createDeviceKey } from '../../keys'
import { resetHardwareKeys } from '../../keys/test-support/hardware-keys'
import { iouDomainOf, signIouBody } from './sign'

vi.mock('../../../modules/hardware-keys/src/HardwareKeysModule', () => import('../../keys/test-support/hardware-keys'))

const programId = Uint8Array.from(getAddressEncoder().encode(BUCKSPAY_PROGRAM_ADDRESS))
const iouDomain = domain(Purpose.Iou, DEVNET_GENESIS_HASH, programId)
const me = p256.getPublicKey(new Uint8Array(32).fill(7), true)
const keyOf = (seed: number) => p256.getPublicKey(new Uint8Array(32).fill(seed), true)
const [ben, cai] = [{ key: keyOf(0xb1) }, { key: keyOf(0xc1) }]
const iouOf = (seq: number, debtor: Uint8Array, creditor: Uint8Array, amount: bigint): Iou => ({
  tab: new Uint8Array(32).fill(0x7a),
  seq,
  debtor,
  creditor,
  mint: new Uint8Array(32).fill(3),
  amount,
  due: 0,
  cause: IouCause.Open,
  reference: new Uint8Array(32),
  memo: new Uint8Array(32),
})
const mine = (seq: number, amount = 10n): Iou => iouOf(seq, me, ben.key, amount)

beforeEach(async () => {
  resetHardwareKeys()
  configureDeviceKey('devnet')
  await createDeviceKey()
})

describe('signIouBody', () => {
  it('the_native_signature_is_bound_to_the_iou_domain', async () => {
    expect(iouDomainOf('devnet')).toEqual(iouDomain)
    expect(iouDomainOf('mainnet')).toEqual(domain(Purpose.Iou, MAINNET_GENESIS_HASH, programId))
    const state = mine(1)
    const signature = await signIouBody(encodeIou(state))
    expect(signature).toHaveLength(64)
    expect(p256.Signature.fromBytes(signature, 'compact').hasHighS()).toBe(false)
    expect(() => verifySignature(me, iouEnvelope(state, iouDomain), signature)).not.toThrow()
    const asNote = envelope(
      domain(Purpose.Note, DEVNET_GENESIS_HASH, programId),
      iouEnvelope(state, iouDomain).subarray(32, 64),
      content(encodeIou(state)),
    )
    expect(() => verifySignature(me, asNote, signature)).toThrow()
  })

  it('same_body_twice_is_not_equivocation', async () => {
    const body = encodeIou(mine(2))
    const [a, b] = [await signIouBody(body), await signIouBody(body)]
    for (const s of [a, b]) expect(() => verifySignature(me, iouEnvelope(mine(2), iouDomain), s)).not.toThrow()
  })

  it('refuses_a_second_body_for_a_used_slot', async () => {
    await signIouBody(encodeIou(mine(3, 10n)))
    await expect(signIouBody(encodeIou(mine(3, 11n)))).rejects.toMatchObject({ code: 'ERR_EQUIVOCATION' })
    await expect(signIouBody(encodeIou(iouOf(3, ben.key, me, 10n)))).rejects.toMatchObject({ code: 'ERR_EQUIVOCATION' })
    await expect(signIouBody(encodeIou(mine(4, 11n)))).resolves.toHaveLength(64)
  })

  it('refuses_bodies_not_naming_this_key_and_other_kinds', async () => {
    await expect(signIouBody(encodeIou(iouOf(1, ben.key, cai.key, 1n)))).rejects.toMatchObject({
      code: 'ERR_IOU_SIGNER',
    })
    const seqZero = encodeIou(mine(1))
    seqZero.set([0, 0, 0, 0], 34)
    // malformed bodies are refused by the protocol check before the native call (the module refuses them too: task 3)
    await expect(signIouBody(seqZero)).rejects.toMatchObject({ code: 'Linkage' })
    const nettingCause = encodeIou(mine(5))
    nettingCause[148] = 3
    nettingCause.set(new Uint8Array(32).fill(0x4e), 149)
    await expect(signIouBody(nettingCause)).rejects.toMatchObject({ code: 'Kind' })
    const HardwareKeys = (await import('../../../modules/hardware-keys/src/HardwareKeysModule')).default
    await expect(HardwareKeys.signIou(nettingCause)).rejects.toMatchObject({ code: 'ERR_INVALID_ENVELOPE' })
    const statement = encodeStatement({
      session: new Uint8Array(32).fill(1),
      mint: new Uint8Array(32).fill(3),
      participants: 2,
      total: 1n,
      expires: 1,
      root: new Uint8Array(32),
      ephemeral: [new Uint8Array(32).fill(2), new Uint8Array(32).fill(3)],
    })
    await expect(signIouBody(statement)).rejects.toMatchObject({ code: 'Kind' })
  })

  it('signs_netting_joins_once_per_session', async () => {
    const join = (ephemeral: number, session = 0x5e) =>
      encodeJoin({ session: new Uint8Array(32).fill(session), ephemeral: new Uint8Array(32).fill(ephemeral), key: me })
    const signature = await signIouBody(join(0x51))
    const message = envelope(iouDomain, joinSlot(new Uint8Array(32).fill(0x5e)), content(join(0x51)))
    expect(() => verifySignature(me, message, signature)).not.toThrow()
    await expect(signIouBody(join(0x52))).rejects.toMatchObject({ code: 'ERR_EQUIVOCATION' })
    await expect(signIouBody(join(0x52, 0x5f))).resolves.toHaveLength(64)
  })
})
