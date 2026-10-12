import { describe, expect, it } from 'vitest'
import { resources } from './resources'

type Tree = { [key: string]: string | Tree }
const flat = (node: Tree | string, path: string[] = []): [string, string][] =>
  typeof node === 'string'
    ? [[path.join('.'), node]]
    : Object.entries(node).flatMap(([key, value]) => flat(value, [...path, key]))
const texts = (language: 'es' | 'pt') =>
  Object.entries(resources[language]).flatMap(([area, tree]) =>
    flat(tree as Tree).map(([key, text]) => ({ id: `${area}:${key}`, key, text })),
  )

const WRONG: Record<'es' | 'pt', RegExp[]> = {
  es: [
    /\bm[oó]vil(es)?\b/i,
    /\bcartera\b/i,
    /\bmonedero\b/i,
    /\btel[eé]fono\b/i,
    /\bvosotros\b/i,
    /\b(pagás|tenés|escribís|tocás|elegís|ingresás)\b/i,
    /\bplata\b/i,
    /\busuari[oa]s?\b/i,
  ],
  pt: [/\btelefone\b/i, /\btelem[oó]vel\b/i, /\becr[ãa]\b/i, /\butilizador(es)?\b/i, /\bportf[oó]lio\b/i],
}
const ENGLISH = /\b(the|and|your|you|with|from|payment request|wallet|settle|lock|bond|nearby check)\b/i
const BRANDS = /USDC|Lateo|Nearby|NFC|QR|SOL|Phantom|Solflare|Solana/g

describe.each(['es', 'pt'] as const)('the glossary in %s', (language) => {
  it('uses none of the words the style guide rules out', () => {
    for (const { id, text } of texts(language)) {
      const cleaned = text.replace(/n[uú]mero de tel[eé]fone?/gi, '')
      for (const pattern of WRONG[language]) expect(cleaned, id).not.toMatch(pattern)
    }
  })

  it('leaves no English sentence behind, outside brand and unit names', () => {
    for (const { id, text } of texts(language)) {
      expect(text.replace(/\{\{\w+\}\}/g, '').replace(BRANDS, ''), id).not.toMatch(ENGLISH)
    }
  })
})
