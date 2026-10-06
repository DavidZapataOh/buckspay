import { beforeEach, describe, expect, it } from 'vitest'
import type { NoteDb } from '../notes/db'
import { migrate } from '../notes/schema'
import { GOSSIP_SCHEMA_VERSION } from '../mesh/gossip'
import { createNodeDb } from '../notes/testing/node-db'
import { activePairing, joinedAuthorities, joinEvent, listEvents, loadPairing, savePairing } from './store'
import { eventWorld } from './testing'

const NOW = 1_800_000_000
const { pairing } = eventWorld()
const invite = { eventId: pairing.eventId, authority: pairing.authority, name: pairing.name, endsAt: NOW + 3600 }

let db: NoteDb
beforeEach(async () => {
  db = createNodeDb()
  await migrate(db)
})

describe('event store', () => {
  it('migrates to its version and again without harm', async () => {
    await migrate(db)
    const [row] = await db.all<{ user_version: number }>('PRAGMA user_version')
    expect(row.user_version).toBe(GOSSIP_SCHEMA_VERSION)
  })

  it('joins an event once and accepts its authority until it ends', async () => {
    expect(await joinEvent(db, invite, NOW)).toBe('joined')
    expect(await joinEvent(db, invite, NOW)).toBe('known')
    expect(await joinedAuthorities(db, NOW)).toEqual([invite.authority])
    expect(await joinedAuthorities(db, invite.endsAt)).toEqual([])
    expect(await listEvents(db, 'attendee')).toEqual([{ ...invite, role: 'attendee' }])
  })

  it('refuses an invite of an event that has ended', async () => {
    expect(await joinEvent(db, { ...invite, endsAt: NOW }, NOW)).toBe('ended')
    expect(await listEvents(db, 'attendee')).toEqual([])
  })

  it('keeps a point pairing with its secret and finds the one still running', async () => {
    await savePairing(db, 'point', { ...pairing, endsAt: NOW + 3600 })
    expect(await loadPairing(db, 'point', pairing.eventId)).toEqual({ ...pairing, endsAt: NOW + 3600 })
    expect(await activePairing(db, NOW)).toMatchObject({ eventId: pairing.eventId })
    expect(await activePairing(db, NOW + 3600)).toBeNull()
  })
})
