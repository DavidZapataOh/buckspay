import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../global.css', import.meta.url), 'utf8')
const names = [
  'background',
  'surface',
  'foreground',
  'muted',
  'outline',
  'primary',
  'on-primary',
  'secondary-container',
  'on-secondary-container',
  'danger',
  'success',
]

function theme(variant: 'light' | 'dark'): Record<string, string> {
  const block = css.match(new RegExp(`@variant ${variant} \\{([^}]*)\\}`))?.[1] ?? ''
  return Object.fromEntries(
    [...block.matchAll(/--color-([a-z-]+): (#[0-9a-f]{6});/g)].map(([, name, hex]) => [name, hex]),
  )
}

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

// [foreground, background, WCAG AA minimum for text]. The selected tab's icon is drawn in
// on-secondary-container on its secondary-container indicator, like the tonal button's label.
const pairs: [string, string, number][] = [
  ['foreground', 'background', 4.5],
  ['foreground', 'surface', 4.5],
  ['muted', 'background', 4.5],
  ['muted', 'surface', 4.5],
  ['on-primary', 'primary', 4.5],
  ['primary', 'background', 4.5],
  ['primary', 'surface', 4.5],
  ['on-secondary-container', 'secondary-container', 4.5],
  ['on-primary', 'danger', 4.5],
  ['danger', 'background', 4.5],
  ['danger', 'surface', 4.5],
  ['success', 'background', 4.5],
  ['success', 'surface', 4.5],
]

describe.each(['light', 'dark'] as const)('%s theme', (variant) => {
  const colors = theme(variant)

  it('defines every token', () => {
    expect(Object.keys(colors).sort()).toEqual([...names].sort())
  })

  it.each(pairs)('%s on %s meets %d:1', (fg, bg, minimum) => {
    expect(contrast(colors[fg], colors[bg])).toBeGreaterThanOrEqual(minimum)
  })
})

const rewardScreens = [
  '../features/rewards/rewards-screen.tsx',
  '../features/rewards/claim-flow.tsx',
  '../features/settings/settings.tsx',
  '../features/activity/activity.tsx',
]
const textTones: Record<string, string> = {
  default: 'foreground',
  muted: 'muted',
  danger: 'danger',
  success: 'success',
}
const buttonPairs: Record<string, [string, string]> = {
  filled: ['on-primary', 'primary'],
  tonal: ['on-secondary-container', 'secondary-container'],
  text: ['primary', 'background'],
  danger: ['on-primary', 'danger'],
}

describe('reward screens', () => {
  const source = rewardScreens.map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n')
  const tones = new Set(
    [...source.matchAll(/tone=(?:"([a-z]+)"|\{([^}]*)\})/g)]
      .flatMap(([, plain, expression]) => (plain ? [plain] : [...expression.matchAll(/'([a-z]+)'/g)].map((m) => m[1])))
      .filter((tone) => tone in textTones),
  )
  const variants = new Set([...source.matchAll(/<Button[^>]*?variant="([a-z]+)"/g)].map(([, variant]) => variant))

  it('uses the text tones and button variants this test knows', () => {
    expect([...tones].sort()).toEqual(expect.arrayContaining(['danger', 'muted']))
    expect([...variants].sort()).toEqual(expect.arrayContaining(['danger', 'filled', 'text', 'tonal']))
    for (const variant of variants) expect(buttonPairs).toHaveProperty(variant)
  })

  describe.each(['light', 'dark'] as const)('%s theme', (variant) => {
    const colors = theme(variant)

    it('draws every text tone on the background and on a surface at 4.5:1', () => {
      for (const tone of tones) {
        for (const ground of ['background', 'surface']) {
          expect(contrast(colors[textTones[tone]], colors[ground])).toBeGreaterThanOrEqual(4.5)
        }
      }
    })

    it('draws every button label at 4.5:1 on its container', () => {
      for (const kind of variants) {
        const [fg, bg] = buttonPairs[kind]
        expect(pairs.some(([f, b]) => f === fg && b === bg)).toBe(true)
        expect(contrast(colors[fg], colors[bg])).toBeGreaterThanOrEqual(4.5)
      }
    })
  })
})
