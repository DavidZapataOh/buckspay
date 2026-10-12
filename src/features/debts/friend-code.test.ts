import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { friendCode, parseFriendCode, parseFriendLink } from './format'

const key = new Uint8Array(33).fill(2)
const hex = bytesToHex(key)

describe('the friend code', () => {
  it('carries the way the other phone should talk, and defaults to the code on the screen', () => {
    expect(friendCode(key)).toBe(`buckspay://debts?friend=${hex}`)
    expect(friendCode(key, 'nearby')).toBe(`buckspay://debts?friend=${hex}&via=nearby`)
    expect(parseFriendLink(friendCode(key))).toEqual({ key, via: 'qr' })
    expect(parseFriendLink(friendCode(key, 'nearby'))).toEqual({ key, via: 'nearby' })
  })

  it('refuses a way it does not know and any other text', () => {
    expect(parseFriendLink(`buckspay://debts?friend=${hex}&via=smoke`)).toBeUndefined()
    expect(parseFriendLink('hello')).toBeUndefined()
    expect(parseFriendCode('hello')).toBeUndefined()
  })

  it('still gives the key alone to a caller that only wants the friend', () => {
    expect(parseFriendCode(friendCode(key, 'nearby'))).toEqual(key)
  })
})
