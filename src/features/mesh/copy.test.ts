import { describe, expect, it } from 'vitest'
import { meshCopy } from './copy'

describe('mesh copy', () => {
  it('never promises always-on, earnings or safety it cannot measure', () => {
    const all = JSON.stringify(meshCopy).toLowerCase()
    for (const word of ['always', 'earn', 'guarantee', 'secure', 'anonymous']) expect(all).not.toContain(word)
  })

  it('says what it uses and what it never shares', () => {
    expect(meshCopy.body).toContain('Bluetooth')
    expect(meshCopy.body).toContain('never shares your balance or where you are')
  })
})
