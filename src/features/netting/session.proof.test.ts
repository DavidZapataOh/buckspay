import { beforeAll, describe, expect, it } from 'vitest'
import { realProver } from './testing/prover-cli'
import { rig, week } from './testing/group'
import { SessionType } from './messages'

let prover: ReturnType<typeof realProver>
beforeAll(() => {
  const bin = process.env.BUCKSPAY_ZK_BIN
  const keys = process.env.BUCKSPAY_ZK_KEYS
  if (!bin || !keys) throw new Error('set BUCKSPAY_ZK_BIN and BUCKSPAY_ZK_KEYS (08-03 netting test keys)')
  prover = realProver(bin, keys)
})

describe('with the real Groth16 prover and verifier', () => {
  it('five_members_net_a_week_and_every_member_verifies_a_valid_proof', async () => {
    const r = await rig(5, week(3), { prove: prover.prove, verify: prover.verify })
    const outcomes = await r.run()
    expect(outcomes.every((o) => o.status === 'agreed' && o.proof === 'valid')).toBe(true)
  }, 600_000)

  it('a_flipped_proof_bit_is_flagged_invalid_while_the_set_is_agreed', async () => {
    const r = await rig(5, week(3), { prove: prover.prove, verify: prover.verify })
    r.net.tap((f) =>
      f.type === SessionType.Final && f.to === 4
        ? { body: Uint8Array.from(f.body, (b, i) => (i === f.body.length - 1 ? b ^ 1 : b)) }
        : undefined,
    )
    const outcomes = await r.run()
    expect(outcomes[4]).toMatchObject({ status: 'agreed', proof: 'invalid' })
    expect(outcomes.slice(0, 4).every((o) => o.status === 'agreed' && o.proof === 'valid')).toBe(true)
  }, 600_000)
})
