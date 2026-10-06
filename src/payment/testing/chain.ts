import { type Issue, type Signed, type Spend, walkChain } from '../../protocol'
import { NOTE_DOMAIN, type Party, signIssue, signSpendWith, MINT } from './world'

const SEC = 86_400

/**
 * An issue by `issuer` to `holders[0]` and a `Spend1` by each holder to the next, signed with the
 * test keys: the chain a note has after it passed through every holder but the last.
 */
export function passedThrough(issuer: Party, holders: Party[]): { issue: Signed<Issue>; spends: Signed<Spend>[] } {
  const issue = signIssue(issuer, {
    issuer: issuer.key,
    mint: MINT,
    lockSeq: 1,
    cumEnd: 5_000_000n,
    salt: new Uint8Array(16),
    owner: { type: 'device', key: holders[0].key },
    amount: 5_000_000n,
    caveats: {
      expiry: 1_900_000_000 + holders.length * SEC,
      hopsLeft: holders.length + 1,
      flags: 0,
      scopeKind: 0,
      scope: new Uint8Array(20),
    },
  })
  const spends: Signed<Spend>[] = []
  for (let i = 0; i < holders.length - 1; i++) {
    const [input] = walkChain(NOTE_DOMAIN, issue, spends).last
    const message: Spend = {
      input: input.id,
      lockSeq: 1,
      salt: new Uint8Array(16).fill(i + 1),
      outputs: {
        type: 'one',
        owner: { type: 'device', key: holders[i + 1].key },
        caveats: { ...input.caveats, expiry: input.caveats.expiry - SEC, hopsLeft: input.caveats.hopsLeft - 1 },
      },
    }
    spends.push({ message, signature: signSpendWith(holders[i], input, message) })
  }
  return { issue, spends }
}
