import { i18n } from '../../i18n'
import { describe, expect, it } from 'vitest'
import { resources } from '../../i18n/resources'

describe('mesh copy', () => {
  it('never promises always-on, earnings or safety it cannot measure', () => {
    const all = JSON.stringify(resources.en.mesh).toLowerCase()
    for (const word of ['always', 'earn', 'guarantee', 'secure', 'anonymous']) expect(all).not.toContain(word)
  })

  it('says what it uses and what it never shares', () => {
    expect(i18n.t('mesh:body')).toContain('Bluetooth')
    expect(i18n.t('mesh:body')).toContain('never shares your balance or where you are')
  })
})
