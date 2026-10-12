import { describe, expect, it } from 'vitest'
import { nettingCopy } from './copy'

const strings = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []
const all = strings(nettingCopy)

describe('netting copy', () => {
  it('never_says_what_the_honest_copy_rules_forbid', () => {
    for (const banned of [
      /claim filed/i,
      /claim pays/i,
      /compensat/i,
      /private payment/i,
      /anonymous/i,
      /nobody can see/i,
      /guaranteed/i,
      /bounded loss/i,
      /Buckspay collects/i,
      /credit line/i,
      /\bearn/i,
      /final for everyone/i,
      /t[ií]tulo valor/i,
      /negotiable/i,
    ])
      for (const text of all) expect(text).not.toMatch(banned)
  })

  it('says_the_required_sentences_exactly', () => {
    for (const sentence of [
      'A debt is a record between you and a friend, signed on both phones.',
      "Netting cancels debts that go in a circle: nobody's balance changes.",
      'Who owes whom is never published. The phone that runs the session sees the debts among the people in it.',
      'On chain, the netting shows only how many people took part and the total cancelled.',
      'Paying the rest is a normal Buckspay payment. The debt goes down for good once the payment settles.',
      'Settling together shows on chain that these payments were made together.',
      'Everyone in the session sees who is in it. The phone that runs the session sees who owes whom.',
      'Paying the record fee or recording it yourself shows on chain that your wallet took part in a netting.',
      "Agreed. Done once recorded (before {expires}). If it is not recorded by {expires}, your payments still count and the circle's debts come back.",
      'Pay the record fee, about 0.001 SOL',
      'This payment failed. The debt is back to {amount}.',
      "A claim burns the other person's deposit. It does not pay you.",
      'Settle or spend this payment before {date} for the debt to go down.',
    ])
      expect(all).toContain(sentence)
  })

  it('never_promises_n_minus_one_payments_and_says_fewer_payments', () => {
    for (const text of all) expect(text).not.toMatch(/n\s*[−-]\s*1\s+payments/i)
    expect(all).toContain('Fewer payments')
    expect(all).toContain('Recording…')
  })

  it('every_placeholder_is_one_of_the_documented_names', () => {
    const known = new Set(['count', 'net', 'time', 'expires', 'amount', 'date', 'path', 'A', 'B', 'C'])
    for (const text of all) for (const [, name] of text.matchAll(/\{([A-Za-z]+)\}/g)) expect(known.has(name)).toBe(true)
  })
})
