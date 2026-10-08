import { it } from 'vitest'
import { cancelCycles } from './cycles'
import { week } from './testing/group'
it('weeks', () => {
  for (const seed of [1, 2, 3]) {
    const s = week(seed)
    const r = cancelCycles(
      5,
      s.map((x, i) => ({
        id: String(i),
        debtor: x.debtor === 'a' ? x.a : x.b,
        creditor: x.debtor === 'a' ? x.b : x.a,
        amount: x.amount,
      })),
    )
    console.log('WEEK', seed, s.length, String(r.total))
  }
})
