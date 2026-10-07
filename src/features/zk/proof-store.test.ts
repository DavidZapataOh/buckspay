import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { dropNote, dropStale, list, put } from './proof-store'

describe('proof store', () => {
  let db: ReturnType<typeof createNodeDb>
  beforeEach(async () => {
    db = createNodeDb()
    await migrate(db)
  })

  const proof = (index: number, vk: string) => ({
    index,
    vkSha256: vk,
    proof: new Uint8Array(192).fill(index),
    publicInputs: new Uint8Array(320),
  })

  it('keeps one proof per message and replaces it', async () => {
    await put(db, 'n1', proof(0, 'k1'))
    await put(db, 'n1', { ...proof(0, 'k1'), proof: new Uint8Array(192).fill(9) })
    const rows = await list(db, 'n1')
    expect(rows).toHaveLength(1)
    expect(rows[0].proof[0]).toBe(9)
  })

  it('refuses a proof of the wrong size', async () => {
    await expect(put(db, 'n1', { ...proof(0, 'k1'), proof: new Uint8Array(196) })).rejects.toThrow()
    await expect(put(db, 'n1', { ...proof(0, 'k1'), publicInputs: new Uint8Array(319) })).rejects.toThrow()
  })

  it('drops proofs made under another key', async () => {
    await put(db, 'n1', proof(0, 'k0'))
    await put(db, 'n1', proof(1, 'k1'))
    await dropStale(db, 'k1')
    expect((await list(db, 'n1')).map((p) => p.index)).toEqual([1])
  })

  it('keeps the proofs of each note apart and forgets a note on request', async () => {
    await put(db, 'n1', proof(0, 'k1'))
    await put(db, 'n2', proof(0, 'k1'))
    await dropNote(db, 'n1')
    expect(await list(db, 'n1')).toEqual([])
    expect(await list(db, 'n2')).toHaveLength(1)
  })

  it('is part of the note store: migrating twice changes nothing', async () => {
    await migrate(db)
    await put(db, 'n1', proof(2, 'k1'))
    expect((await list(db, 'n1'))[0].index).toBe(2)
  })
})
