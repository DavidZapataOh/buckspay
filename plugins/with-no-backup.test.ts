import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { backupRules, dataExtractionRules } = require('./with-no-backup') as {
  backupRules: () => string
  dataExtractionRules: () => string
}

const excluded = ['domain="sharedpref" path="SecureStore"']
const included = '<include domain="sharedpref" path="."/>'

describe('backup exclusions', () => {
  it('back up only the shared preferences, so no database or file is included', () => {
    for (const rules of [backupRules(), dataExtractionRules()]) {
      expect(rules).toContain(included)
      expect(rules).not.toMatch(/<include domain="(file|database|root|external|device_[a-z_]+)"/)
    }
  })

  it('keep the SecureStore key out of the cloud backup', () => {
    for (const rules of [backupRules(), dataExtractionRules()]) {
      for (const path of excluded) expect(rules).toContain(`<exclude ${path}`)
    }
  })

  it('exclude it from a device transfer as well', () => {
    const [cloud, transfer] = dataExtractionRules().split('<device-transfer>')
    for (const part of [cloud, transfer]) {
      for (const path of excluded) expect(part).toContain(`<exclude ${path}`)
    }
  })

  it('are well formed: every section opens and closes once', () => {
    expect(backupRules()).toMatch(/^<\?xml[^>]*\?>\s*<full-backup-content>[\s\S]*<\/full-backup-content>\s*$/)
    const rules = dataExtractionRules()
    for (const tag of ['data-extraction-rules', 'cloud-backup', 'device-transfer']) {
      expect(rules.split(`<${tag}>`)).toHaveLength(2)
      expect(rules.split(`</${tag}>`)).toHaveLength(2)
    }
  })
})
