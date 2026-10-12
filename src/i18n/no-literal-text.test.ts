import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOTS = ['src/app', 'src/features', 'src/components']
const SKIP = [/\.test\.tsx?$/, /-lab\.tsx$/, /intl-lab\.tsx$/, /\/testing\//, /\/test-support\//]
const TEXT_ATTRIBUTES = new Set([
  'label',
  'title',
  'placeholder',
  'accessibilityLabel',
  'accessibilityHint',
  'message',
  'detail',
  'subtitle',
  'description',
  'headerTitle',
])

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.tsx') ? [path] : []
  })

const literalsIn = (path: string) => {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const text = node.getText().trim()
      if (/[A-Za-zÀ-ÿ]{2,}/.test(text)) found.push(text)
    }
    if (
      ts.isJsxAttribute(node) &&
      TEXT_ATTRIBUTES.has(node.name.getText()) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      if (/[A-Za-zÀ-ÿ]{2,}/.test(node.initializer.text)) found.push(`${node.name.getText()}="${node.initializer.text}"`)
    }
    const inJsxExpression = (n: ts.Node) => {
      for (let up = n.parent; up; up = up.parent) {
        if (ts.isJsxExpression(up)) return true
        if (ts.isBlock(up) || ts.isSourceFile(up)) return false
      }
      return false
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      inJsxExpression(node) &&
      /^[A-Z][a-z]{2,}/.test(node.text) &&
      !ts.isJsxAttribute(node.parent)
    ) {
      found.push(`"${node.text}"`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('the screens', () => {
  it('write no text of their own: every sentence comes from a catalog', () => {
    const offenders = ROOTS.flatMap((root) => files(root))
      .filter((path) => !SKIP.some((pattern) => pattern.test(path)))
      .flatMap((path) => literalsIn(path).map((text) => `${relative('.', path)}: ${text}`))
    expect(offenders).toEqual([])
  })
})
