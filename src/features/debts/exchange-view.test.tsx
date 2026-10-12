import { Text } from 'react-native'
import { describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { mount, texts } from '../remote/ui-testing'
import { ExchangeView } from './exchange-view'
import type { DebtLink } from './use-debts'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (n: string | string[]) => (Array.isArray(n) ? n.map(() => '#000000') : '#000000'),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
vi.mock('../qr/scan-screen', () => ({ ScanScreen: () => null }))
vi.mock('../qr/qr-presenter', () => ({
  QrPresenter: ({ texts: codes }: { texts: string[] }) => <Text>{`code:${codes[0]}`}</Text>,
}))

const link = (chosen: 'qr' | 'nearby', decided = true, connect = () => new Promise<never>(() => undefined)) =>
  ({
    chosen,
    decided,
    session: { texts: undefined, progress: undefined, push: vi.fn() },
    connect,
  }) as unknown as DebtLink

const view = (chosen: 'qr' | 'nearby', idleCode?: string, l: DebtLink = link(chosen)) => (
  <ExchangeView
    link={l}
    title="Ready to receive a debt"
    run={async () => undefined}
    onDone={vi.fn()}
    onFail={vi.fn()}
    onCancel={vi.fn()}
    idleCode={idleCode}
  />
)

describe('the debt exchange while it waits', () => {
  it('shows the friend code over Nearby too, because the other phone needs it to find this one', async () => {
    const r = await mount(view('nearby', 'buckspay://debts?friend=02aa'))
    const shown = texts(r.root)
    expect(shown).toContain('code:buckspay://debts?friend=02aa')
    expect(shown).toContain('Your friend scans this code to send you a debt.')
  })

  it('shows no code when there is none to show', async () => {
    const r = await mount(view('nearby'))
    expect(texts(r.root).join('\n')).not.toContain('code:')
  })

  it('connects only once the medium is decided, and over that medium', async () => {
    const connect = vi.fn(() => new Promise<never>(() => undefined))
    const r = await mount(view('qr', undefined, link('qr', false, connect)))
    expect(connect).not.toHaveBeenCalled()
    await act(async () => r.update(view('nearby', undefined, link('nearby', true, connect))))
    expect(connect).toHaveBeenCalledTimes(1)
  })
})
