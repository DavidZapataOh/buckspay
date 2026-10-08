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
  'danger',
  'success',
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
