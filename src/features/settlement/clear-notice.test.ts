import { describe, expect, it } from 'vitest'
import { needsClearNotice } from './clear-notice'
import { passedThrough } from '../../payment/testing/chain'
import { party } from '../../payment/testing/world'

const issuer = party(1)
const a = party(2)
const b = party(3)
const me = party(4)

describe('needsClearNotice', () => {
  it('is null for a note paid straight from its issuer to me', () => {
    expect(needsClearNotice(passedThrough(issuer, [me]), me.key)).toBeNull()
  })
  it('counts every other holder once', () => {
    expect(needsClearNotice(passedThrough(issuer, [a, b, a, me]), me.key)).toEqual({ holders: 2 })
  })
  it('does not count me when my own change passed through the chain', () => {
    expect(needsClearNotice(passedThrough(issuer, [me, a, me]), me.key)).toEqual({ holders: 1 })
  })
  it('does not count the issuer when it held the note itself', () => {
    expect(needsClearNotice(passedThrough(issuer, [issuer, a, me]), me.key)).toEqual({ holders: 1 })
  })
})
