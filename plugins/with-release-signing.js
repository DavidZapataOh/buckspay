const { withAppBuildGradle } = require('expo/config-plugins')

const RELEASE_CONFIG = `        release {
            storeFile file(System.getenv('BUCKSPAY_KEYSTORE'))
            storePassword System.getenv('BUCKSPAY_KEYSTORE_PASSWORD')
            keyAlias System.getenv('BUCKSPAY_KEY_ALIAS')
            keyPassword System.getenv('BUCKSPAY_KEY_PASSWORD')
        }
`

/** Makes the release build sign with the keystore the environment names; its secrets are read when Gradle runs and never written. */
function releaseSigning(gradle) {
  if (gradle.includes("System.getenv('BUCKSPAY_KEYSTORE')")) return gradle
  const debugBlock = /(signingConfigs \{\n\s+debug \{[\s\S]*?\n\s+\}\n)(\s+\})/
  const releaseBuild = /(release \{\n(?:\s*\/\/[^\n]*\n)*\s*)signingConfig signingConfigs\.debug/
  if (!debugBlock.test(gradle) || !releaseBuild.test(gradle)) {
    throw new Error('The Android build file has no signing configuration this plugin knows how to change')
  }
  return gradle
    .replace(debugBlock, `$1${RELEASE_CONFIG}$2`)
    .replace(releaseBuild, '$1signingConfig signingConfigs.release')
}

/** Applies only when a keystore is named, so a build without one is exactly what it was. */
function withReleaseSigning(config) {
  if (!process.env.BUCKSPAY_KEYSTORE) return config
  return withAppBuildGradle(config, (config) => {
    config.modResults.contents = releaseSigning(config.modResults.contents)
    return config
  })
}

module.exports = withReleaseSigning
module.exports.releaseSigning = releaseSigning
