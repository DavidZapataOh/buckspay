import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FakeNfc } from '../nfc/testing/fake'
import { createNfcTransport } from '../nfc/transport'
import { runAll } from './vitest-shim'

/** The suite imports `vitest`; the app cannot, so the end-to-end build aliases that import to the shim. */
async function contractThroughTheShim() {
  const source = readFileSync(new URL('./contract.ts', import.meta.url), 'utf8').replace(
    "from 'vitest'",
    "from './vitest-shim'",
  )
  const path = new URL('./contract.shimmed.ts', import.meta.url).pathname
  writeFileSync(path, source)
  try {
    return (await import(/* @vite-ignore */ path)) as typeof import('./contract')
  } finally {
    rmSync(path)
  }
}

describe('the contract through the in-app shim', () => {
  it('runs every case of describeTransportContract and they all pass', async () => {
    const { describeTransportContract } = await contractThroughTheShim()
    describeTransportContract('nfc', () => {
      const [a, b] = FakeNfc.pair()
      return [createNfcTransport(a), createNfcTransport(b)]
    })
    const results = await runAll()
    expect(results).toHaveLength(10)
    expect(results.filter((r) => !r.ok)).toEqual([])
  })
})
