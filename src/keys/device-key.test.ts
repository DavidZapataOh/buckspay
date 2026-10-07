import { p256 } from '@noble/curves/nist.js'
import { BUCKSPAY_PROGRAM_ADDRESS } from '@project/anchor'
import { address, getAddressEncoder } from '@solana/kit'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import vectors from '../../anchor/crates/protocol/tests/vectors/v1.json'
import { PAY_LIMITS } from '../features/pay/limits'
import HardwareKeys from '../../modules/hardware-keys/src/HardwareKeysModule'
import {
  type Caveats,
  type Commitment,
  content,
  decodeCommitment,
  deviceBindingEnvelope,
  DEVNET_GENESIS_HASH,
  domain,
  encodeCommitment,
  encodeIssueBody,
  encodeSpendBody,
  encodeWitnessBody,
  envelope,
  EXPIRY_STEP,
  GRACE,
  type Issue,
  issueSlot,
  messageId,
  NO_LOCK,
  type Output,
  outputId,
  paywordEnvelope,
  type Owner,
  Purpose,
  reclaimEnvelope,
  recordAddress,
  type Spend,
  verifySettlement,
  verifySignature,
  verifyWitness,
  type WitnessBody,
  WitnessError,
} from '../protocol'
import { compactLowS } from './convert'
import * as keys from '.'
import * as internal from './device-key'
import { configuredProgramId, nativeSignatures, resetHardwareKeys } from './test-support/hardware-keys'

vi.mock('../../modules/hardware-keys/src/HardwareKeysModule', () => import('./test-support/hardware-keys'))

const programId = Uint8Array.from(getAddressEncoder().encode(BUCKSPAY_PROGRAM_ADDRESS))
const noteDomain = domain(Purpose.Note, DEVNET_GENESIS_HASH, programId)
const wallet = address('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS')
const walletBytes = Uint8Array.from(getAddressEncoder().encode(wallet))
const merchant: Owner = { type: 'account', address: new Uint8Array(32).fill(9) }
const caveats = (hopsLeft: number): Caveats => ({
  expiry: 2_000_000_000,
  hopsLeft,
  flags: 0,
  scopeKind: 0,
  scope: new Uint8Array(20),
})
const issueOf = (issuer: Uint8Array, owner: Owner, start: bigint, amount: bigint): Issue => ({
  issuer,
  mint: new Uint8Array(32).fill(4),
  lockSeq: 0,
  cumEnd: start + amount,
  salt: new Uint8Array(16).fill(5),
  owner,
  amount,
  caveats: caveats(owner.type === 'device' ? 3 : 0),
})
const issuedOutput = (issue: Issue): Output => {
  const env = envelope(
    noteDomain,
    issueSlot(issue.lockSeq, issue.cumEnd - issue.amount, issue.cumEnd),
    content(encodeIssueBody(issue)),
  )
  return { id: outputId(messageId(env), 0), owner: issue.owner, amount: issue.amount, caveats: issue.caveats }
}
const settle = (input: Output): Spend => ({
  input: input.id,
  lockSeq: NO_LOCK,
  salt: new Uint8Array(16).fill(6),
  outputs: { type: 'one', owner: merchant, caveats: caveats(0) },
})
const pay = (input: Output, owner: Owner, hopsLeft: number): Spend => ({
  input: input.id,
  lockSeq: 0,
  salt: new Uint8Array(16).fill(6),
  outputs: { type: 'one', owner, caveats: caveats(hopsLeft) },
})
const code = (value: string) => expect.objectContaining({ name: 'ProtocolError', code: value })

describe('device key', () => {
  beforeEach(() => {
    resetHardwareKeys()
    keys.configureDeviceKey('devnet')
  })

  it('creates the key once and returns it as SEC1', async () => {
    expect(await keys.getDeviceKey()).toBeNull()
    const created = await keys.createDeviceKey()
    expect(created.publicKey).toHaveLength(33)
    expect(created.securityLevel).toBe('software')
    expect((await keys.getDeviceKey())?.publicKey).toEqual(created.publicKey)
  })

  it('binds signatures to the program built into the app and one cluster', () => {
    expect(configuredProgramId()).toEqual(programId)
    keys.configureDeviceKey('devnet')
    expect(() => keys.configureDeviceKey('mainnet')).toThrow(
      expect.objectContaining({ code: 'ERR_ALREADY_CONFIGURED' }),
    )
  })

  it('signs issues the protocol settles, low-S although Keystore is not', async () => {
    const { publicKey } = await keys.createDeviceKey()
    for (let i = 0n; i < 16n; i++) {
      const issue = issueOf(publicKey, merchant, i * 100n, 100n)
      const signed = await keys.signIssue(issue)
      expect(p256.Signature.fromBytes(signed.signature, 'compact').hasHighS()).toBe(false)
      expect(verifySettlement(noteDomain, programId, signed, []).output.amount).toBe(100n)
    }
    expect(nativeSignatures().some((der) => p256.Signature.fromBytes(der, 'der').hasHighS())).toBe(true)
  })

  it('signs a spend of an output it owns in the slot of its output id', async () => {
    const { publicKey } = await keys.createDeviceKey()
    const issue = issueOf(publicKey, { type: 'device', key: publicKey }, 0n, 250n)
    const signedIssue = await keys.signIssue(issue)
    const input = issuedOutput(signedIssue.message)
    const signedSpend = await keys.signSpend(input, settle(input))
    const settled = verifySettlement(noteDomain, programId, signedIssue, [signedSpend])
    expect(settled.output.owner).toEqual(merchant)
    expect(settled.output.amount).toBe(250n)
  })

  it('refuses what it could not sign validly before reaching the native module', async () => {
    const { publicKey } = await keys.createDeviceKey()
    const other = p256.getPublicKey(new Uint8Array(32).fill(8))
    const sign = vi.spyOn(HardwareKeys, 'signNote')
    await expect(keys.signIssue(issueOf(other, merchant, 0n, 10n))).rejects.toThrow(code('Signer'))
    await expect(keys.signIssue({ ...issueOf(publicKey, merchant, 0n, 10n), amount: 0n })).rejects.toThrow(
      code('Amount'),
    )
    const owned = issuedOutput(issueOf(publicKey, { type: 'device', key: publicKey }, 0n, 10n))
    const notMine = { ...owned, owner: { type: 'device', key: other } as Owner }
    await expect(keys.signSpend(notMine, settle(notMine))).rejects.toThrow(code('Owner'))
    await expect(keys.signSpend({ ...owned, owner: merchant }, settle(owned))).rejects.toThrow(code('Owner'))
    await expect(keys.signSpend(owned, { ...settle(owned), input: new Uint8Array(32) })).rejects.toThrow(
      code('Linkage'),
    )
    await expect(keys.signSpend(owned, { ...settle(owned), salt: new Uint8Array(15) })).rejects.toThrow(code('Length'))
    expect(sign).not.toHaveBeenCalled()
  })

  it('refuses a spend this hop does not allow before reaching the native module', async () => {
    const { publicKey } = await keys.createDeviceKey()
    const owned = issuedOutput(issueOf(publicKey, { type: 'device', key: publicKey }, 0n, 10n))
    const device: Owner = { type: 'device', key: p256.getPublicKey(new Uint8Array(32).fill(8)) }
    const sign = vi.spyOn(HardwareKeys, 'signNote')
    const whole: Spend = {
      ...pay(owned, device, 2),
      outputs: { type: 'two', owner0: device, amount0: 10n, caveats0: caveats(2), owner1: owned.owner },
    }
    await expect(keys.signSpend(owned, whole)).rejects.toThrow(code('Amount'))
    await expect(keys.signSpend(owned, pay(owned, device, 3))).rejects.toThrow(code('Attenuation'))
    await expect(keys.signSpend(owned, { ...pay(owned, device, 2), lockSeq: NO_LOCK })).rejects.toThrow(code('Lock'))
    expect(sign).not.toHaveBeenCalled()
    await keys.signSpend(owned, pay(owned, device, 2))
    expect(sign).toHaveBeenCalledWith(owned.id, expect.any(Uint8Array))
  })

  it('pays with an output until its expiry and settles it until expiry + GRACE', async () => {
    const { publicKey } = await keys.createDeviceKey()
    const owned = issuedOutput(issueOf(publicKey, { type: 'device', key: publicKey }, 0n, 10n))
    const device: Owner = { type: 'device', key: p256.getPublicKey(new Uint8Array(32).fill(8)) }
    const at = (seconds: number) => vi.setSystemTime(seconds * 1000)
    try {
      at(owned.caveats.expiry + 1)
      await expect(keys.signSpend(owned, pay(owned, device, 2))).rejects.toThrow(code('Expired'))
      at(owned.caveats.expiry + GRACE + 1)
      await expect(keys.signSpend(owned, settle(owned))).rejects.toThrow(code('Expired'))
      at(owned.caveats.expiry + GRACE)
      await keys.signSpend(owned, settle(owned))
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets to a new identity and forgets the old key', async () => {
    const { publicKey } = await keys.createDeviceKey()
    const issue = issueOf(publicKey, merchant, 0n, 10n)
    await keys.signIssue(issue)
    await internal.resetDeviceIdentity()
    expect(await keys.getDeviceKey()).toBeNull()
    const sign = vi.spyOn(HardwareKeys, 'signNote').mockClear()
    await expect(keys.signIssue(issue)).rejects.toThrow(code('Signer'))
    expect(sign).not.toHaveBeenCalled()
  })

  it('refuses a native signature over another envelope', async () => {
    const { publicKey } = await keys.createDeviceKey()
    const issue = issueOf(publicKey, merchant, 0n, 10n)
    const zero = new Uint8Array(32)
    vi.spyOn(HardwareKeys, 'signNote').mockImplementationOnce(() => HardwareKeys.sign('witness', zero, zero))
    await expect(keys.signIssue(issue)).rejects.toThrow(code('Signature'))
  })

  it('signs witnesses only under their own domain, and no other purpose over a caller digest', async () => {
    const { publicKey } = await keys.createDeviceKey()
    const slot = new Uint8Array(32).fill(1)
    const digest = new Uint8Array(32).fill(2)
    const signature = await internal.signWitness(slot, digest)
    for (const purpose of Object.values(Purpose).filter((purpose) => purpose !== 'ticket')) {
      const message = envelope(domain(purpose, DEVNET_GENESIS_HASH, programId), slot, digest)
      if (purpose === Purpose.Witness) expect(() => verifySignature(publicKey, message, signature)).not.toThrow()
      else expect(() => verifySignature(publicKey, message, signature)).toThrow()
      if (purpose !== Purpose.Witness && purpose !== Purpose.PayWord)
        await expect(HardwareKeys.sign(purpose as never, slot, digest)).rejects.toThrow('ERR_INVALID_ENVELOPE')
    }
    await expect(internal.signWitness(new Uint8Array(31), digest)).rejects.toThrow(code('Length'))
  })

  it('signs a device binding the program rebuilds, over its own key and under the device domain only', async () => {
    const { publicKey } = await keys.createDeviceKey()
    const binding = await keys.signDeviceBinding(wallet)
    expect(binding.key).toEqual(publicKey)
    const deviceDomain = domain(Purpose.Device, DEVNET_GENESIS_HASH, programId)
    expect(binding.envelope).toEqual(deviceBindingEnvelope(deviceDomain, walletBytes, publicKey))
    expect(() => verifySignature(publicKey, binding.envelope, binding.signature)).not.toThrow()
    const others = Object.values(Purpose).filter((purpose) => purpose !== Purpose.Device && purpose !== 'ticket')
    for (const purpose of others) {
      const message = new Uint8Array(binding.envelope)
      message.set(domain(purpose, DEVNET_GENESIS_HASH, programId))
      expect(() => verifySignature(publicKey, message, binding.signature)).toThrow()
    }
  })

  it('refuses a device binding before the key exists, and a native signature over another binding', async () => {
    await internal.resetDeviceIdentity()
    const sign = vi.spyOn(HardwareKeys, 'signDeviceBinding').mockClear()
    await expect(keys.signDeviceBinding(wallet)).rejects.toThrow(code('Signer'))
    expect(sign).not.toHaveBeenCalled()
    await keys.createDeviceKey()
    sign.mockImplementationOnce(() => HardwareKeys.signDeviceBinding(new Uint8Array(32).fill(1)))
    await expect(keys.signDeviceBinding(wallet)).rejects.toThrow(code('Signature'))
  })

  it('says which native error stopped a signature, so a screen can tell the person what to do', async () => {
    const { publicKey } = await keys.createDeviceKey()
    const locked = Object.assign(new Error('locked'), { code: 'ERR_DEVICE_LOCKED' })
    vi.spyOn(HardwareKeys, 'signNote').mockRejectedValueOnce(locked)
    const failure = await keys.signIssue(issueOf(publicKey, merchant, 0n, 10n)).catch((error: unknown) => error)
    expect(keys.nativeErrorCode(failure)).toBe('ERR_DEVICE_LOCKED')
    expect(keys.nativeErrorCode(new Error('plain'))).toBeUndefined()
    expect(keys.nativeErrorCode('ERR_DEVICE_LOCKED')).toBeUndefined()
  })

  it('exports structured signing and the confirmed reset, and signs no device message over a caller digest', async () => {
    expect(Object.keys(keys).filter((name) => name.startsWith('sign'))).toEqual([
      'signDeviceBinding',
      'signIssue',
      'signPayword',
      'signReclaim',
      'signSpend',
      'signWitnessRecord',
    ])
    expect(keys).toHaveProperty('resetDeviceIdentity')
    const signers = Object.keys(internal).filter((name) => name.startsWith('sign'))
    expect(signers.sort()).toEqual([
      'signDeviceBinding',
      'signIssue',
      'signPayword',
      'signReclaim',
      'signSpend',
      'signWitness',
      'signWitnessRecord',
    ])
    await keys.createDeviceKey()
    const digest = new Uint8Array(32).fill(2)
    await expect(HardwareKeys.sign('device' as never, walletBytes, digest)).rejects.toThrow('ERR_INVALID_ENVELOPE')
  })

  it('changes the salt of an issue until its output has a record address', async () => {
    const { publicKey } = await keys.createDeviceKey()
    let unrecordable: Issue | undefined
    for (let n = 0; !unrecordable; n++) {
      const candidate = { ...issueOf(publicKey, merchant, 0n, 100n), salt: new Uint8Array(16).fill(n) }
      if (!recordAddress(programId, issuedOutput(candidate).id)) unrecordable = candidate
    }
    const signed = await keys.signIssue(unrecordable)
    expect(signed.message.salt).not.toEqual(unrecordable.salt)
    expect(recordAddress(programId, issuedOutput(signed.message).id)).toBeDefined()
    expect(verifySettlement(noteDomain, programId, signed, [])).toBeDefined()
  })

  it('gives a payment to a device the step, and a salt that leaves every output a record address', async () => {
    const { publicKey } = await keys.createDeviceKey()
    const holder: Owner = { type: 'device', key: publicKey }
    const signedIssue = await keys.signIssue(issueOf(publicKey, holder, 0n, 250n))
    const input = issuedOutput(signedIssue.message)
    const device: Owner = { type: 'device', key: p256.getPublicKey(new Uint8Array(32).fill(8)) }
    // The issue's expiry is the payment's, and the change keeps it: the step is the signer's to apply.
    const split: Spend = {
      input: input.id,
      lockSeq: 0,
      salt: new Uint8Array(16).fill(6),
      outputs: { type: 'two', owner0: device, amount0: 100n, caveats0: caveats(2), owner1: holder },
    }
    const signed = await keys.signSpend(input, split)
    if (signed.message.outputs.type !== 'two') throw new Error('unexpected outputs')
    expect(signed.message.outputs.caveats0.expiry).toBe(input.caveats.expiry - EXPIRY_STEP)
    const id = messageId(envelope(noteDomain, input.id, content(encodeSpendBody(signed.message))))
    for (const index of [0, 1]) expect(recordAddress(programId, outputId(id, index))).toBeDefined()
    const toAccount = await keys.signSpend(input, settle(input))
    expect(toAccount.message.outputs).toEqual(settle(input).outputs)
  })

  it('signs a reclaim of an output it recorded, once expiry + GRACE has passed', async () => {
    const { publicKey } = await keys.createDeviceKey()
    const holder: Owner = { type: 'device', key: publicKey }
    const signedIssue = await keys.signIssue(issueOf(publicKey, holder, 0n, 250n))
    const output = issuedOutput(signedIssue.message)
    const reclaimDomain = domain(Purpose.Reclaim, DEVNET_GENESIS_HASH, programId)
    const at = (seconds: number) => vi.setSystemTime(seconds * 1000)
    try {
      // The guard knows nothing of an output it was not told about.
      at(output.caveats.expiry + GRACE + 1)
      await expect(keys.signReclaim(output, output.caveats.expiry + GRACE + 100)).rejects.toThrow(
        expect.objectContaining({ code: 'ERR_UNKNOWN_OUTPUT' }),
      )
      await keys.recordOutput(output)
      // Not while its payee can still settle it.
      at(output.caveats.expiry + GRACE)
      await expect(keys.signReclaim(output, output.caveats.expiry + GRACE + 100)).rejects.toThrow(
        expect.objectContaining({ code: 'ERR_RECLAIM_TOO_EARLY' }),
      )
      at(output.caveats.expiry + GRACE + 1)
      const deadline = output.caveats.expiry + GRACE + 3_600
      const signature = await keys.signReclaim(output, deadline)
      expect(() =>
        verifySignature(publicKey, reclaimEnvelope(reclaimDomain, output.id, deadline), signature),
      ).not.toThrow()
      expect(() =>
        verifySignature(publicKey, reclaimEnvelope(reclaimDomain, output.id, deadline + 1), signature),
      ).toThrow()
      // A deadline more than a day ahead or already past is not signed.
      for (const bad of [output.caveats.expiry + GRACE + 1 + 86_401, output.caveats.expiry + GRACE]) {
        await expect(keys.signReclaim(output, bad)).rejects.toThrow(
          expect.objectContaining({ code: 'ERR_INVALID_DEADLINE' }),
        )
      }
      // Even for an output it signed a spend of: a transfer that tore is the case it is for.
      at(output.caveats.expiry - 100)
      await keys.signSpend(output, settle(output))
      at(output.caveats.expiry + GRACE + 1)
      await expect(keys.signReclaim(output, deadline)).resolves.toBeInstanceOf(Uint8Array)
    } finally {
      vi.useRealTimers()
    }
  })

  it('records and reclaims only outputs it owns', async () => {
    const { publicKey } = await keys.createDeviceKey()
    const other: Owner = { type: 'device', key: p256.getPublicKey(new Uint8Array(32).fill(8)) }
    const theirs = issuedOutput(issueOf(publicKey, other, 0n, 10n))
    const record = vi.spyOn(HardwareKeys, 'recordOutput')
    const reclaim = vi.spyOn(HardwareKeys, 'signReclaim')
    await expect(keys.recordOutput(theirs)).rejects.toThrow(code('Owner'))
    await expect(keys.signReclaim(theirs, 1)).rejects.toThrow(code('Owner'))
    await expect(keys.signReclaim({ ...theirs, owner: merchant }, 1)).rejects.toThrow(code('Owner'))
    expect(record).not.toHaveBeenCalled()
    expect(reclaim).not.toHaveBeenCalled()
  })

  it('refuses a native reclaim signature over another message', async () => {
    const { publicKey } = await keys.createDeviceKey()
    const output = issuedOutput(issueOf(publicKey, { type: 'device', key: publicKey }, 0n, 10n))
    await keys.recordOutput(output)
    vi.setSystemTime((output.caveats.expiry + GRACE + 1) * 1000)
    try {
      const deadline = output.caveats.expiry + GRACE + 100
      vi.spyOn(HardwareKeys, 'signReclaim').mockImplementationOnce(() => HardwareKeys.signNote(output.id, output.id))
      await expect(keys.signReclaim(output, deadline)).rejects.toThrow(code('Signature'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('records the cluster it signs for', () => {
    expect(keys.deviceKeyCluster()).toBe('devnet')
  })

  describe('signWitnessRecord', () => {
    const witnessBody = (payerKey: Uint8Array, over: Partial<WitnessBody> = {}): WitnessBody => ({
      paymentId: new Uint8Array(32).fill(0x77),
      payerKey,
      receiverKey: p256.getPublicKey(new Uint8Array(32).fill(2), true),
      challenge: Uint8Array.from({ length: 8 }, (_, i) => i + 1),
      issuedAt: 1_800_000_000,
      channel: 1,
      ...over,
    })
    const witnessDomain = domain(Purpose.Witness, DEVNET_GENESIS_HASH, programId)

    it('signs the body under the witness domain', async () => {
      const { publicKey } = await keys.createDeviceKey()
      const body = witnessBody(publicKey)
      const signature = await keys.signWitnessRecord(body)
      expect(signature).toHaveLength(64)
      expect(() => verifyWitness(witnessDomain, { ...body, signature })).not.toThrow()
    })

    it('asks the module for the payment id as slot and the body hash as digest', async () => {
      const { publicKey } = await keys.createDeviceKey()
      const body = witnessBody(publicKey)
      const sign = vi.spyOn(HardwareKeys, 'sign')
      await keys.signWitnessRecord(body)
      expect(sign).toHaveBeenCalledTimes(1)
      expect(sign).toHaveBeenCalledWith('witness', body.paymentId, content(encodeWitnessBody(body)))
    })

    it('refuses a body for another payer key', async () => {
      await keys.createDeviceKey()
      const sign = vi.spyOn(HardwareKeys, 'sign')
      const other = p256.getPublicKey(new Uint8Array(32).fill(3), true)
      await expect(keys.signWitnessRecord(witnessBody(other))).rejects.toThrow(code('Signer'))
      expect(sign).not.toHaveBeenCalled()
    })

    it('refuses a malformed body', async () => {
      const { publicKey } = await keys.createDeviceKey()
      const sign = vi.spyOn(HardwareKeys, 'sign')
      await expect(keys.signWitnessRecord(witnessBody(publicKey, { challenge: new Uint8Array(7) }))).rejects.toThrow(
        WitnessError,
      )
      expect(sign).not.toHaveBeenCalled()
    })

    it('throws when the module returns a signature that does not verify', async () => {
      const { publicKey } = await keys.createDeviceKey()
      const zero = new Uint8Array(32)
      vi.spyOn(HardwareKeys, 'sign').mockImplementationOnce(() => HardwareKeys.signNote(zero, zero))
      await expect(keys.signWitnessRecord(witnessBody(publicKey))).rejects.toThrow(code('Signature'))
    })
  })

  describe('signPayword', () => {
    const vector = vectors.payword
    const paywordDomain = domain(Purpose.PayWord, DEVNET_GENESIS_HASH, new Uint8Array(32).fill(0xb0))
    const golden = decodeCommitment(hexToBytes(vector.commitment))
    const open = (over: Partial<Commitment> = {}): Commitment => ({
      ...golden,
      expiry: Math.floor(Date.now() / 1000) + 3 * 86_400,
      ...over,
    })

    it('signs exactly the envelope the program rebuilds from the commitment', async () => {
      const { publicKey } = await keys.createDeviceKey()
      const c = open()
      const signature = await keys.signPayword(c)
      expect(signature).toHaveLength(64)
      const message = paywordEnvelope(domain(Purpose.PayWord, DEVNET_GENESIS_HASH, programId), c)
      expect(() => verifySignature(publicKey, message, signature)).not.toThrow()
    })

    it('hands the module the slot and content of the golden envelope', async () => {
      await keys.createDeviceKey()
      const sign = vi.spyOn(HardwareKeys, 'sign')
      await keys.signPayword(golden)
      const message = hexToBytes(vector.envelope)
      expect(bytesToHex(paywordEnvelope(paywordDomain, golden))).toBe(vector.envelope)
      expect(sign).toHaveBeenCalledWith('payword', message.slice(32, 64), message.slice(64, 96))
    })

    it('is valid under the payword domain and under no other purpose', async () => {
      const { publicKey } = await keys.createDeviceKey()
      const c = open()
      const signature = await keys.signPayword(c)
      const body = encodeCommitment(c)
      const slot = sha256(concatBytes(utf8ToBytes(Purpose.PayWord), body))
      for (const purpose of Object.values(Purpose).filter((purpose) => purpose !== 'ticket')) {
        const message = envelope(domain(purpose, DEVNET_GENESIS_HASH, programId), slot, content(body))
        const verifies = () => verifySignature(publicKey, message, signature)
        if (purpose === Purpose.PayWord) expect(verifies).not.toThrow()
        else expect(verifies).toThrow()
      }
    })

    it('is not accepted as the signature of any other purpose', async () => {
      const { publicKey } = await keys.createDeviceKey()
      const c = open()
      const body = encodeCommitment(c)
      const slot = sha256(concatBytes(utf8ToBytes(Purpose.PayWord), body))
      const witness = await internal.signWitness(slot, content(body))
      const payword = domain(Purpose.PayWord, DEVNET_GENESIS_HASH, programId)
      expect(() => verifySignature(publicKey, envelope(payword, slot, content(body)), witness)).toThrow()
      const note = await HardwareKeys.signNote(slot, content(body))
      expect(() => verifySignature(publicKey, envelope(payword, slot, content(body)), compactLowS(note))).toThrow()
    })

    it('refuses a commitment that expired', async () => {
      await keys.createDeviceKey()
      const sign = vi.spyOn(HardwareKeys, 'sign')
      await expect(keys.signPayword(open({ expiry: Math.floor(Date.now() / 1000) - 1 }))).rejects.toThrow(
        code('Expired'),
      )
      expect(sign).not.toHaveBeenCalled()
    })

    it('signs a commitment until the second it expires', async () => {
      await keys.createDeviceKey()
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(1_800_000_000_000)
        await expect(keys.signPayword(open({ expiry: 1_800_000_000 }))).rejects.toThrow(code('Expired'))
        await expect(keys.signPayword(open({ expiry: 1_800_000_001 }))).resolves.toHaveLength(64)
      } finally {
        vi.useRealTimers()
      }
    })

    it('refuses a channel worth a biometric confirmation, since it is signed without one', async () => {
      await keys.createDeviceKey()
      const sign = vi.spyOn(HardwareKeys, 'sign')
      const limit = PAY_LIMITS.biometricFrom
      const wordValue = limit >> BigInt(golden.depth)
      await expect(keys.signPayword(open({ wordValue }))).rejects.toThrow(code('Amount'))
      await expect(keys.signPayword(open({ wordValue: wordValue + 1n }))).rejects.toThrow(code('Amount'))
      expect(sign).not.toHaveBeenCalled()
      await expect(keys.signPayword(open({ wordValue: wordValue - 1n }))).resolves.toHaveLength(64)
    })

    it('refuses a malformed commitment', async () => {
      await keys.createDeviceKey()
      const sign = vi.spyOn(HardwareKeys, 'sign')
      await expect(keys.signPayword(open({ depth: 9 }))).rejects.toThrow(code('Depth'))
      await expect(keys.signPayword(open({ depth: 3 }))).rejects.toThrow(code('Depth'))
      await expect(keys.signPayword(open({ root: new Uint8Array(31) }))).rejects.toThrow(code('Length'))
      expect(sign).not.toHaveBeenCalled()
    })

    it('throws when the module returns a signature that does not verify', async () => {
      await keys.createDeviceKey()
      const zero = new Uint8Array(32)
      vi.spyOn(HardwareKeys, 'sign').mockImplementationOnce(() => HardwareKeys.signNote(zero, zero))
      await expect(keys.signPayword(open())).rejects.toThrow(code('Signature'))
    })
  })
})
