import { describe, expect, it } from 'vitest'
import { resources } from './resources'

type Tree = { [key: string]: string | Tree }
type Language = keyof typeof resources

const flat = (node: Tree | string, path: string[] = []): [string, string][] =>
  typeof node === 'string'
    ? [[path.join('.'), node]]
    : Object.entries(node).flatMap(([key, value]) => flat(value, [...path, key]))

const texts = (language: Language) =>
  Object.entries(resources[language]).flatMap(([area, tree]) =>
    flat(tree as Tree).map(([key, text]) => ({ id: `${area}:${key}`, key, text })),
  )

const JARGON: Record<Language, RegExp[]> = {
  en: [
    /(?<!screen )\blocks?\b/i,
    /\bbonds?\b/i,
    /\bsettl(e|es|ed|ing|ement)\b/i,
    /\ballowance\b/i,
    /\bissuer\b/i,
    /\bmint\b/i,
    /\bhops?\b/i,
    /\brelay(s|ed)?\b/i,
    /\bwitness\b/i,
    /\bgateway\b/i,
    /\binterval\b/i,
    /\bbytes?\b/i,
    /\bTEE\b/,
    /\bsigned\b/i,
  ],
  es: [
    /\block\b/i,
    /\bbond\b/i,
    /\bsettle/i,
    /\bnotas? (al|ao) portador\b/i,
    /\bbytes?\b/i,
    /\bTEE\b/,
    /\bfirmad[oa]s?\b/i,
  ],
  pt: [
    /\block\b/i,
    /\bbond\b/i,
    /\bsettle/i,
    /\bnotas? (al|ao) portador\b/i,
    /\bbytes?\b/i,
    /\bTEE\b/,
    /\bassinad[oa]s?\b/i,
  ],
}

const PROMISES: Record<Language, RegExp[]> = {
  en: [/\bprotect(ed|ion)?\b/i, /\binsur(ed|ance)\b/i, /\bguarantee[ds]?\b/i],
  es: [/protegid/i, /asegurad/i, /garantiz/i, /garant[ií]a/i],
  pt: [/protegid/i, /segurad[oa]/i, /garantid/i, /garantia/i],
}

const technical = (key: string) => key.split('.').some((part) => part.startsWith('details'))
const sentences = (text: string) => text.split(/[.!?¿¡]+(?:\s|$)/).filter((part) => part.trim().length > 0)

describe.each(Object.keys(resources) as Language[])('the texts in %s', (language) => {
  it('never promise protection, insurance or a guarantee', () => {
    const offenders = texts(language).filter(({ text }) => PROMISES[language].some((pattern) => pattern.test(text)))
    expect(offenders.map(({ id }) => id)).toEqual([])
  })

  it('use none of the words a person without technical knowledge does not know, outside the details', () => {
    const offenders = texts(language).filter(
      ({ key, text }) =>
        !technical(key) && JARGON[language].some((pattern) => pattern.test(text.replace(/\{\{[^}]*\}\}/g, ''))),
    )
    expect(offenders.map(({ id }) => id)).toEqual([])
  })

  it('carry no error code in parentheses outside the details', () => {
    const offenders = texts(language).filter(({ key, text }) => !technical(key) && /\([a-z]+(?:_[a-z]+)+\)/.test(text))
    expect(offenders.map(({ id }) => id)).toEqual([])
  })

  it('say at most two sentences in a notice or an error', () => {
    const offenders = texts(language).filter(
      ({ key, text }) =>
        !technical(key) &&
        /(^|\.)(error|payError|reason|reasons|refusal|serverReasons|notice|failed|rejected)(\.|$)/.test(key) &&
        sentences(text).length > 2,
    )
    expect(offenders.map(({ id }) => id)).toEqual([])
  })
})
