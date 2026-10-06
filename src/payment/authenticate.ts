import * as LocalAuthentication from 'expo-local-authentication'
import { PayError } from './pay'

/**
 * Asks for a strong biometric or the screen lock. False when the person declines. A phone with no screen
 * lock cannot confirm a payment this large, and says so as a refusal, never as a silent pass.
 */
export async function authenticate(title: string, subtitle: string, cancel: string): Promise<boolean> {
  if ((await LocalAuthentication.getEnrolledLevelAsync()) === LocalAuthentication.SecurityLevel.NONE) {
    throw new PayError('Declined', 'NoScreenLock')
  }
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: title,
    promptSubtitle: subtitle,
    cancelLabel: cancel,
    biometricsSecurityLevel: 'strong',
    disableDeviceFallback: false,
  })
  return result.success
}
