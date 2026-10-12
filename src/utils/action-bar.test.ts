import { describe, expect, it } from 'vitest'
import { actionBarPadding } from './action-bar'

describe('actionBarPadding', () => {
  it('leaves the buttons clear of the system bar, with a margin of 8 over it or 24 at least', () => {
    expect(actionBarPadding(0)).toBe(24)
    expect(actionBarPadding(16)).toBe(24)
    expect(actionBarPadding(48)).toBe(56)
  })
})
