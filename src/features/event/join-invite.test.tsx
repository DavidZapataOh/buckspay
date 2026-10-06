import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteDb } from '../notes/db'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { JoinInvite } from './join-invite'
import { joinedAuthorities, joinEvent } from './store'
import { eventWorld } from './testing'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))
vi.mock('expo-symbols', () => ({ unstable_getMaterialSymbolSourceAsync: vi.fn(async () => ({ uri: 'icon.png' })) }))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('expo-linking', () => ({ openURL: vi.fn() }))
vi.mock('../network/use-network', () => ({
  useNetwork: () => ({ getExplorerUrl: (path: string) => `https://explorer/${path}` }),
}))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

const NOW = 1_800_000_000
const { pairing } = eventWorld()
const invite = { eventId: pairing.eventId, authority: pairing.authority, name: pairing.name, endsAt: NOW + 3600 }

const texts = (root: ReactTestInstance) =>
  root.findAllByType('Text' as never).map((node) => [node.props.children].flat().join(''))
const press = (root: ReactTestInstance, testID: string) =>
  act(async () =>
    root.findAll((node) => node.props.testID === testID && typeof node.props.onPress === 'function')[0].props.onPress(),
  )

let db: NoteDb
beforeEach(async () => {
  db = createNodeDb()
  await migrate(db)
})

const mount = async (scanned = invite) =>
  (
    await act(async () =>
      create(<JoinInvite invite={scanned} onJoin={(i) => joinEvent(db, i, NOW)} onDone={() => {}} />),
    )
  ).root

describe('joining an event from its invite', () => {
  it('accepts the credit of its authority until the event ends', async () => {
    const root = await mount()
    expect(texts(root)).toContain('Feria')
    await press(root, 'join-accept')
    expect(texts(root)).toContain('You can now accept credit from Feria.')
    expect(await joinedAuthorities(db, NOW)).toEqual([invite.authority])
    expect(await joinedAuthorities(db, invite.endsAt)).toEqual([])
  })

  it('changes nothing the second time the same invite is scanned', async () => {
    await press(await mount(), 'join-accept')
    const second = await mount()
    await press(second, 'join-accept')
    expect(texts(second)).toContain('You already joined Feria.')
    expect(await db.all('SELECT 1 FROM event')).toHaveLength(1)
  })

  it('refuses an invite whose event has ended', async () => {
    const root = await mount({ ...invite, endsAt: NOW - 1 })
    await press(root, 'join-accept')
    expect(texts(root)).toContain('This event has ended')
    expect(await db.all('SELECT 1 FROM event')).toHaveLength(0)
  })
})
