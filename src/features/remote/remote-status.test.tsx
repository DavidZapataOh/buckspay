import { describe, expect, it, vi } from 'vitest'
import { remoteCopy } from './copy'
import { RemoteStatus } from './remote-status'
import { mount, texts } from './ui-testing'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))

describe('remote payment detail', () => {
  it('says how many phones took it and that an expired one paid nothing', async () => {
    const r = await mount(<RemoteStatus state="remote-expired" passedTo={2} deadline={1_800_000_000} />)
    const shown = texts(r.root)
    expect(shown).toContain(remoteCopy.status.expired)
    expect(shown).toContain('Passed to 2 phones nearby')
    expect(shown).toContain(remoteCopy.detail.expiredNote)
  })
  it('shows the deadline of one still on its way, without the expired note', async () => {
    const r = await mount(<RemoteStatus state="remote-relaying" passedTo={0} deadline={1_800_000_000} />)
    expect(texts(r.root)).not.toContain(remoteCopy.detail.expiredNote)
    expect(texts(r.root).join('\n')).toContain(new Date(1_800_000_000 * 1000).toLocaleString())
  })
})
