import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dir = new URL('.', import.meta.url)
const files = readdirSync(dir).filter((f) => /(-screen|-view|-section)\.tsx$/.test(f) && !f.endsWith('.test.tsx'))
const source = (f: string) => readFileSync(new URL(f, dir), 'utf8')

describe('netting screens at large font scale', () => {
  it('there_are_screen_files_to_check', () => expect(files.length).toBeGreaterThanOrEqual(6))
  it.each(files)('%s has_no_fixed_heights_truncation_or_disabled_font_scaling', (file) => {
    const text = source(file)
    expect(text).not.toMatch(/numberOfLines|ellipsizeMode|allowFontScaling=\{false\}|maxFontSizeMultiplier/)
    expect(text).not.toMatch(/(?<![-\w])(h|w)-\d+|height:\s*\d|style=\{\{[^}]*height/)
    expect(text).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
  })
  it.each(files)('%s uses_only_the_01_05_components_and_native_layout_primitives', (file) => {
    const imports = [...source(file).matchAll(/from '([^']+)'/g)].map((m) => m[1])
    for (const spec of imports.filter((s) => s.startsWith('.')))
      expect(spec).toMatch(
        /components\/(screen|app-text|button|list-row|address-row|status-note|icon-button)|\.\/(copy|session-view|consent-view|remainder-section)|qr\/(qr-code|qr-scanner)|payment\/copy|utils\/format-amount|theme\//,
      )
  })
})
