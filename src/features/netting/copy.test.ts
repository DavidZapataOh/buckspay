import { describe, expect, it } from 'vitest'
import { resources } from '../../i18n/resources'

type Tree = { [key: string]: string | Tree }
const strings = (value: string | Tree): string[] =>
  typeof value === 'string' ? [value] : Object.values(value).flatMap(strings)
const all = strings(resources.en.netting as Tree)

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
      'A debt is a record between you and a friend, confirmed on both phones.',
      "Cancelling removes debts that go in a circle: nobody's balance changes.",
      'Who owes whom is never made public. The phone that runs the session sees the debts among the people in it.',
      'Publicly, only how many people took part and the total cancelled are shown.',
      'Paying the rest is a normal Buckspay payment. The debt goes down for good once the payment is credited.',
      'Crediting together shows publicly that these payments were made together.',
      'Everyone in the session sees who is in it. The phone that runs the session sees who owes whom.',
      'Paying the recording fee, or recording it yourself, shows publicly that your wallet took part in cancelling debts.',
      "Agreed. It's done once recorded (before {{expires}}). If it isn't recorded by {{expires}}, your payments still count and the circle's debts come back.",
      'Pay the fee, about 0.001 SOL',
      'This payment failed. The debt is back to {{amount}}.',
      "Reporting the loss destroys the other person's security deposit. It does not pay you.",
      'Use this payment, or let it be credited, before {{date}} for the debt to go down.',
    ])
      expect(all).toContain(sentence)
  })

  it('never_promises_n_minus_one_payments_and_says_fewer_payments', () => {
    for (const text of all) expect(text).not.toMatch(/n\s*[−-]\s*1\s+payments/i)
    expect(all).toContain('Fewer payments')
    expect(all).toContain('Recording…')
  })

  it('every_placeholder_is_one_of_the_documented_names', () => {
    const known = new Set(['count', 'net', 'time', 'expires', 'amount', 'date', 'path', 'from', 'to'])
    for (const text of all) for (const [, name] of text.matchAll(/\{\{(\w+)\}\}/g)) expect(known.has(name)).toBe(true)
  })
})
