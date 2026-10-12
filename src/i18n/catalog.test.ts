import { describe, expect, it } from 'vitest'
import { resources } from './resources'

type Tree = { [key: string]: string | Tree }

const PLURAL = /_(zero|one|two|few|many|other)$/
const flat = (node: Tree | string, path: string[] = []): [string, string][] =>
  typeof node === 'string'
    ? [[path.join('.'), node]]
    : Object.entries(node).flatMap(([key, value]) => flat(value, [...path, key]))
const base = (key: string) => key.replace(PLURAL, '')
const holes = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort()

// The Spanish and Portuguese texts of these areas are written with the translations; until then they hold only what the formats use.
const INCOMPLETE = new Set<string>([])

const languages = Object.keys(resources) as (keyof typeof resources)[]
const areas = Object.keys(resources.en) as (keyof typeof resources.en)[]

describe.each(areas)('the catalog "%s"', (area) => {
  const english = flat(resources.en[area] as Tree)

  it('has no empty text and no single-brace placeholder left over from the old modules', () => {
    for (const [key, text] of english) {
      expect(text.trim(), key).not.toBe('')
      expect(text.replace(/\{\{\w+\}\}/g, ''), key).not.toMatch(/[{}]/)
    }
  })

  describe.each(languages.filter((language) => language !== 'en'))('in %s', (language) => {
    const present = area in resources[language] && !INCOMPLETE.has(`${language}:${area}`)
    const other = present ? flat((resources[language] as Record<string, unknown>)[area] as Tree) : []

    it.skipIf(!present)('has the same keys as English, counting a plural form as its base key', () => {
      expect([...new Set(other.map(([key]) => base(key)))].sort()).toEqual(
        [...new Set(english.map(([key]) => base(key)))].sort(),
      )
    })

    it.skipIf(!present)('gives every plural a form for "other", the one every language needs', () => {
      const plurals = new Set(other.filter(([key]) => PLURAL.test(key)).map(([key]) => base(key)))
      for (const key of plurals)
        expect(
          other.some(([k]) => k === `${key}_other`),
          key,
        ).toBe(true)
    })

    it.skipIf(!present)('has the same placeholders as the English text, in every form', () => {
      const original = new Map(english.map(([key, text]) => [base(key), holes(text)]))
      for (const [key, text] of other) {
        const wanted = original.get(base(key))
        const own = holes(text)
        expect(
          own.filter((name) => name !== 'count'),
          key,
        ).toEqual((wanted ?? []).filter((name) => name !== 'count'))
      }
    })
  })
})
