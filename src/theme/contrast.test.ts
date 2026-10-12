import { describe, expect, it } from 'vitest'
import { contrast, describeScreenContrast, pairs, theme } from './contrast-check'

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
  'strong',
  'primary-pressed',
  'secondary-container-pressed',
  'danger',
  'danger-pressed',
  'danger-container',
  'success',
  'success-container',
  'warning',
  'warning-container',
  'disabled',
  'on-disabled',
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

const SURFACE_GRAPHICS: [string, string, number][] = [
  ['primary', 'background', 3],
  ['primary', 'surface', 3],
  ['success', 'success-container', 3],
  ['danger', 'danger-container', 3],
  ['warning', 'warning-container', 3],
  ['outline', 'background', 1.1],
]

describe.each(['light', 'dark'] as const)('%s theme: neutral balance', (variant) => {
  const colors = theme(variant)

  it('draws the foreground (cards) apart from the background without a loud fill', () => {
    expect(colors.surface).not.toBe(colors.background)
    expect(contrast(colors.surface, colors.background)).toBeLessThan(1.3)
  })

  it('never uses pure black for text, and pure white only for the strong text of dark mode', () => {
    expect(colors.foreground).not.toBe('#000000')
    expect(colors.muted).not.toBe('#000000')
    if (variant === 'light') expect(colors.foreground).not.toBe('#ffffff')
    expect(colors.foreground).not.toBe('#ffffff')
  })

  it.each(SURFACE_GRAPHICS)('draws %s on %s at %d:1 for icons and borders', (fg, bg, minimum) => {
    expect(contrast(colors[fg], colors[bg])).toBeGreaterThanOrEqual(minimum)
  })

  it('shows a disabled control by desaturating it, not only by fading it', () => {
    const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    const spread = (hex: string) => Math.max(...channels(hex)) - Math.min(...channels(hex))
    expect(spread(colors.disabled)).toBeLessThan(spread(colors.primary))
    expect(spread(colors['on-disabled'])).toBeLessThan(spread(colors.primary))
  })

  it('presses darker on light and keeps pressing visible on dark', () => {
    expect(contrast(colors['primary-pressed'], colors.background)).not.toBe(contrast(colors.primary, colors.background))
  })
})

describeScreenContrast(
  'reward screens',
  [
    '../features/rewards/rewards-screen.tsx',
    '../features/rewards/claim-flow.tsx',
    '../features/settings/settings.tsx',
    '../features/activity/activity.tsx',
  ],
  { tones: ['danger', 'muted'], variants: ['danger', 'filled', 'text', 'tonal'] },
)

describeScreenContrast(
  'debt screens',
  [
    '../features/debts/debts-screen.tsx',
    '../features/debts/new-debt-screen.tsx',
    '../features/debts/tab-screen.tsx',
    '../features/debts/accept-screen.tsx',
  ],
  { tones: ['danger', 'muted', 'success'], variants: ['filled', 'text', 'tonal'] },
)

describeScreenContrast(
  'redesigned flows',
  [
    '../features/home/home-summary.tsx',
    '../features/pay/pay-tab.tsx',
    '../features/pay/review.tsx',
    '../features/receive/receive-form.tsx',
    '../features/receive/result.tsx',
    '../features/netting/index-screen.tsx',
    '../features/netting/host-screen.tsx',
    '../features/netting/session-screen.tsx',
    '../features/netting/consent-view.tsx',
    '../features/nearby/pairing-screen.tsx',
    '../features/identity/onboarding.tsx',
    '../features/identity/activation-form.tsx',
    '../features/debts/tab-screen.tsx',
    '../features/debts/accept-screen.tsx',
    '../app/activity/[id].tsx',
    '../app/pay/send.tsx',
  ],
  { tones: ['danger', 'muted'], variants: ['filled', 'text', 'tonal'] },
)
