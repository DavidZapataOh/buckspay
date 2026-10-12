import { describe, expect, it } from 'vitest'
import { resources } from './resources'

type Tree = { [key: string]: string | Tree }
const flat = (node: Tree | string, path: string[] = []): [string, string][] =>
  typeof node === 'string'
    ? [[path.join('.'), node]]
    : Object.entries(node).flatMap(([key, value]) => flat(value, [...path, key]))

const BUTTON =
  /^(action|button|cta|title|addMoney|resume|discard|showAgain|setupAction|cancel|continue|create|pay|close|claim|share|send|sign|decline|paste|download|withdraw|connect|activate|scan|settleNow|noticeWait|noticeSettle|labelContinue|labelNotNow)$/i
const TAB = /^tabs\./
const LIMIT = 28

describe.each(Object.keys(resources) as (keyof typeof resources)[])('the buttons and labels in %s', (language) => {
  it(`fit in ${LIMIT} characters, so they do not break at a large font`, () => {
    for (const [area, tree] of Object.entries(resources[language])) {
      for (const [key, text] of flat(tree as Tree)) {
        const last = key.split('.').at(-1) ?? ''
        if (/\.title$|^title$/.test(key)) continue
        if (!BUTTON.test(last.replace(/_(one|other)$/, '')) && !TAB.test(key)) continue
        expect(text.replace(/\{\{\w+\}\}/g, 'X').length, `${area}:${key}`).toBeLessThanOrEqual(LIMIT)
      }
    }
  })
})
