import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { releaseSigning } = require('./with-release-signing') as { releaseSigning: (gradle: string) => string }

const template = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            minifyEnabled true
        }
    }
`

describe('signing a release build with its own key', () => {
  it('reads the keystore and its passwords from the environment when Gradle runs, never from a file', () => {
    const gradle = releaseSigning(template)
    expect(gradle).toContain("storeFile file(System.getenv('BUCKSPAY_KEYSTORE'))")
    expect(gradle).toContain("storePassword System.getenv('BUCKSPAY_KEYSTORE_PASSWORD')")
    expect(gradle).toContain("keyAlias System.getenv('BUCKSPAY_KEY_ALIAS')")
    expect(gradle).toContain("keyPassword System.getenv('BUCKSPAY_KEY_PASSWORD')")
  })

  it('moves only the release build to that key and leaves the debug build on the debug key', () => {
    const gradle = releaseSigning(template)
    const [debug, release] = gradle.split('release {\n            // Caution')
    expect(debug).toContain('signingConfig signingConfigs.debug')
    expect(release).toContain('signingConfig signingConfigs.release')
    expect(release).not.toContain('signingConfig signingConfigs.debug')
  })

  it('does nothing twice', () => {
    const once = releaseSigning(template)
    expect(releaseSigning(once)).toBe(once)
  })

  it('refuses a build file it does not recognise rather than shipping the debug key by accident', () => {
    expect(() => releaseSigning('android { }')).toThrow(/signing/i)
  })
})
