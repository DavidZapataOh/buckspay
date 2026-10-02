import { p256 } from '@noble/curves/nist.js'
import { BUCKSPAY_PROGRAM_ADDRESS } from '@project/anchor'
import { getAddressEncoder } from '@solana/kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import HardwareKeys from '../../modules/hardware-keys/src/HardwareKeysModule'
import {
  type Caveats,
  content,
  DEVNET_GENESIS_HASH,
  domain,
  encodeIssueBody,
  envelope,
  GRACE,
  type Issue,
  issueSlot,
  messageId,
  NO_LOCK,
  type Output,
  outputId,
  type Owner,
  Purpose,
  type Spend,
  verifySettlement,
  verifySignature,
} from '../protocol'
import * as keys from '.'
import * as internal from './device-key'
import { configuredProgramId, nativeSignatures, resetHardwareKeys } from './test-support/hardware-keys'

vi.mock('../../modules/hardware-keys/src/HardwareKeysModule', () => import('./test-support/hardware-keys'))

const programId = Uint8Array.from(getAddressEncoder().encode(BUCKSPAY_PROGRAM_ADDRESS))
const noteDomain = domain(Purpose.Note, DEVNET_GENESIS_HASH, programId)
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
      const signature = await keys.signIssue(issue)
      expect(p256.Signature.fromBytes(signature, 'compact').hasHighS()).toBe(false)
      expect(verifySettlement(noteDomain, { message: issue, signature }, []).output.amount).toBe(100n)
    }
    expect(nativeSignatures().some((der) => p256.Signature.fromBytes(der, 'der').hasHighS())).toBe(true)
  })

  it('signs a spend of an output it owns in the slot of its output id', async () => {
    const { publicKey } = await keys.createDeviceKey()
    const issue = issueOf(publicKey, { type: 'device', key: publicKey }, 0n, 250n)
    const signedIssue = { message: issue, signature: await keys.signIssue(issue) }
    const input = issuedOutput(issue)
    const spend = settle(input)
    const signedSpend = { message: spend, signature: await keys.signSpend(input, spend) }
    const settled = verifySettlement(noteDomain, signedIssue, [signedSpend])
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
      if (purpose !== Purpose.Witness)
        await expect(HardwareKeys.sign(purpose as never, slot, digest)).rejects.toThrow('ERR_INVALID_ENVELOPE')
    }
    await expect(internal.signWitness(new Uint8Array(31), digest)).rejects.toThrow(code('Length'))
  })

  it('exports signing for issues and spends only, no reset, and signs nothing else', () => {
    expect(Object.keys(keys).filter((name) => name.startsWith('sign'))).toEqual(['signIssue', 'signSpend'])
    expect(keys).not.toHaveProperty('resetDeviceIdentity')
    const signers = Object.keys(internal).filter((name) => name.startsWith('sign'))
    expect(signers.sort()).toEqual(['signIssue', 'signSpend', 'signWitness'])
  })
})
