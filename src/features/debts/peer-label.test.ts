import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '../../i18n'
import { peerLabel } from './format'

const key = new Uint8Array(33).fill(2)

describe('peerLabel', () => {
  afterEach(() => i18n.changeLanguage('en'))

  it('names a friend with the word of the language in use', async () => {
    expect(peerLabel(key)).toMatch(/^Friend [0-9a-f]{6}$/)
    await i18n.changeLanguage('es')
    expect(peerLabel(key)).toMatch(/^Amigo [0-9a-f]{6}$/)
    await i18n.changeLanguage('pt')
    expect(peerLabel(key)).toMatch(/^Amigo [0-9a-f]{6}$/)
  })
})
