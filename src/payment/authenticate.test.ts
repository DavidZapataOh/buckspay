import * as LocalAuthentication from 'expo-local-authentication'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticate } from './authenticate'
import { PayError } from './pay'

vi.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0, SECRET: 1 },
  getEnrolledLevelAsync: vi.fn(),
  authenticateAsync: vi.fn(),
}))

const level = vi.mocked(LocalAuthentication.getEnrolledLevelAsync)
const prompt = vi.mocked(LocalAuthentication.authenticateAsync)

beforeEach(() => vi.clearAllMocks())

describe('authenticate', () => {
  it('asks for a strong biometric or the screen lock, with the payment in the prompt', async () => {
    level.mockResolvedValue(LocalAuthentication.SecurityLevel.SECRET)
    prompt.mockResolvedValue({ success: true })
    expect(await authenticate('Confirm payment', 'Pay 25.00 USDC to phone ABCD-EF23', 'Cancel')).toBe(true)
    expect(prompt).toHaveBeenCalledWith({
      promptMessage: 'Confirm payment',
      promptSubtitle: 'Pay 25.00 USDC to phone ABCD-EF23',
      cancelLabel: 'Cancel',
      biometricsSecurityLevel: 'strong',
      disableDeviceFallback: false,
    })
  })

  it('is false when the person declines or the prompt is cancelled', async () => {
    level.mockResolvedValue(LocalAuthentication.SecurityLevel.SECRET)
    prompt.mockResolvedValue({ success: false, error: 'user_cancel' })
    expect(await authenticate('a', 'b', 'c')).toBe(false)
  })

  it('refuses before asking when the phone has no screen lock at all', async () => {
    level.mockResolvedValue(LocalAuthentication.SecurityLevel.NONE)
    const failure = await authenticate('a', 'b', 'c').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PayError)
    expect(failure).toMatchObject({ code: 'Declined', cause: 'NoScreenLock' })
    expect(prompt).not.toHaveBeenCalled()
  })
})
