import { i18n } from '../../i18n'
import { describe, expect, it, vi } from 'vitest'

import { FarAwayReceive } from './far-away-receive'
import { decodePayLink } from './pay-link'
import { M, W } from './testing'
import { byLabel, mount, press, type } from './ui-testing'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
vi.mock('../qr/qr-code', () => ({ QrCode: () => null }))

describe('Far away receive', () => {
  it('refuses to share a link without a token account', async () => {
    const r = await mount(<FarAwayReceive wallet={W} mint={M} tokenAccount="missing" />)
    expect(byLabel(r.root, i18n.t('remote:share'))).toBeUndefined()
    expect(byLabel(r.root, i18n.t('remote:createAccount'))).toBeDefined()
  })
  it('shares a link that carries the wallet and the name when the account exists', async () => {
    const shared: string[] = []
    const r = await mount(<FarAwayReceive wallet={W} mint={M} tokenAccount="exists" onShare={(t) => shared.push(t)} />)
    await type(r.root, i18n.t('remote:name'), 'Ana')
    await press(r.root, i18n.t('remote:share'))
    expect(decodePayLink(shared[0])).toEqual({ wallet: W, mint: M, name: 'Ana' })
  })
  it('offers nothing while the account is being checked', async () => {
    const r = await mount(<FarAwayReceive wallet={W} mint={M} tokenAccount="checking" />)
    expect(byLabel(r.root, i18n.t('remote:share'))).toBeUndefined()
    expect(byLabel(r.root, i18n.t('remote:createAccount'))).toBeUndefined()
  })
})
