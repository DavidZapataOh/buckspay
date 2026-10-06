const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins')
const fs = require('node:fs')
const path = require('node:path')

// An <include> makes Android back up only what it lists, so the note store, its database and every
// other file stay out. The SecureStore preferences hold a key a restored phone does not have.
const excluded = ['sharedpref" path="SecureStore']
const exclusions = (indent) => excluded.map((rule) => `${indent}<exclude domain="${rule}"/>`).join('\n')

const backupRules = () => `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
  <include domain="sharedpref" path="."/>
${exclusions('  ')}
</full-backup-content>
`

const dataExtractionRules = () => `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup>
    <include domain="sharedpref" path="."/>
${exclusions('    ')}
  </cloud-backup>
  <device-transfer>
    <include domain="sharedpref" path="."/>
${exclusions('    ')}
  </device-transfer>
</data-extraction-rules>
`

const BACKUP = 'buckspay_backup_rules'
const EXTRACTION = 'buckspay_data_extraction_rules'

/** Replaces Android's backup rules with ones that back up only the shared preferences, minus SecureStore. */
function withNoBackup(config) {
  config = withAndroidManifest(config, (config) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults)
    application.$['android:fullBackupContent'] = `@xml/${BACKUP}`
    application.$['android:dataExtractionRules'] = `@xml/${EXTRACTION}`
    return config
  })
  return withDangerousMod(config, [
    'android',
    (config) => {
      const directory = path.join(config.modRequest.platformProjectRoot, 'app/src/main/res/xml')
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, `${BACKUP}.xml`), backupRules())
      fs.writeFileSync(path.join(directory, `${EXTRACTION}.xml`), dataExtractionRules())
      return config
    },
  ])
}

module.exports = withNoBackup
module.exports.backupRules = backupRules
module.exports.dataExtractionRules = dataExtractionRules
