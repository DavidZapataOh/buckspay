import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOTS = ['src/app', 'src/features', 'src/components']
const SKIP = [/\.test\.tsx?$/, /-lab\.tsx$/, /intl-lab\.tsx$/, /\/testing\//, /\/test-support\//]
// The technical reasons these two jobs record when they fail; a screen shows them after its own sentence, in the person's language.
const TECHNICAL_REASONS = [/\/rewards\/secrets-claim\.ts$/, /\/relay\/words\.ts$/]
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

const files = (dir: string, extensions = ['.tsx']): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory()
      ? files(path, extensions)
      : extensions.some((extension) => path.endsWith(extension))
        ? [path]
        : []
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

// A sentence in English written in the code: a capitalised word and a lower-case one, or four plain words in a row.
const START = /^[A-Z][a-z’']+ [a-z]/
const RUN = /(?:^|[^A-Za-z’'])[a-z’']{2,}(?: [a-z’']{2,}){3,}/
const NOT_TEXT = new Set([
  'className',
  'contentContainerClassName',
  'testID',
  'accessibilityRole',
  'key',
  'variant',
  'tone',
])

const sentencesIn = (path: string) => {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const found: string[] = []
  const exempt = (node: ts.Node) => {
    for (let up = node.parent; up; up = up.parent) {
      if (ts.isThrowStatement(up) || ts.isImportDeclaration(up) || ts.isExportDeclaration(up) || ts.isTypeNode(up))
        return true
      if (ts.isBinaryExpression(up) && /^[!=]==?$/.test(up.operatorToken.getText())) return true
      if (ts.isNewExpression(up) && /^(Type|Range|Protocol)?Error$/.test(up.expression.getText())) return true
      if (ts.isCallExpression(up) && /^(super|console|log|reject|expect)\b/.test(up.expression.getText())) return true
      if (ts.isJsxAttribute(up) && NOT_TEXT.has(up.name.getText())) return true
    }
    return false
  }
  const visit = (node: ts.Node) => {
    const whole = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
    const part = ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
    if (
      (whole || part) &&
      (whole ? START.test(node.text) || RUN.test(node.text) : RUN.test(node.text)) &&
      !exempt(node)
    ) {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
      found.push(`${line}: ${node.text.slice(0, 80)}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('the code', () => {
  it('writes no English sentence for a person in a string: every one comes from a catalog', () => {
    const offenders = ROOTS.flatMap((root) => files(root, ['.ts', '.tsx']))
      .filter((path) => !SKIP.some((pattern) => pattern.test(path)))
      .filter((path) => !TECHNICAL_REASONS.some((pattern) => pattern.test(path)))
      .flatMap((path) => sentencesIn(path).map((text) => `${relative('.', path)}:${text}`))
    expect(offenders).toEqual([])
  })
})
