import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const { withE2E } = createRequire(import.meta.url)('./metro.e2e.js') as {
  withE2E: (config: { resolver: Record<string, unknown> }, e2e: boolean) => { resolver: Record<string, unknown> }
}

const fallback = { type: 'sourceFile', filePath: '/fallback' }
const resolve = (e2e: boolean, name: string) => {
  const config = withE2E({ resolver: { resolveRequest: () => fallback } }, e2e)
  return (config.resolver.resolveRequest as (c: unknown, n: string, p: string) => unknown)({}, name, 'android')
}

describe('metro resolver', () => {
  it('replaces the contract lab with an empty module in a normal build', () => {
    expect(resolve(false, '../features/nfc/nfc-lab')).toEqual({ type: 'empty' })
  })

  it('leaves vitest to the default resolution in a normal build', () => {
    expect(resolve(false, 'vitest')).toBe(fallback)
  })

  it('keeps the lab and maps vitest to the shim in an end-to-end build', () => {
    expect(resolve(true, '../features/nfc/nfc-lab')).toBe(fallback)
    expect(resolve(true, 'vitest')).toMatchObject({
      type: 'sourceFile',
      filePath: expect.stringContaining('vitest-shim'),
    })
  })
})
