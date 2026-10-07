import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { zkPins } from './zk-pins'

const dir = mkdtempSync(join(tmpdir(), 'zk-pins-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const manifest = (name: string, extra: object) => {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify({ VKSHA256: 'v', PKBinSHA256: 'p', PKDumpSHA256: 'd', CCSSHA256: 'c', ...extra }))
  return path
}

describe('zkPins', () => {
  it('pins nothing without a manifest', () => {
    expect(zkPins({})).toEqual([])
  })

  it('pins the hashes of the manifests it is given', () => {
    const path = manifest('ceremony.json', { Test: false })
    expect(zkPins({ ZK_KEYS_MANIFEST: path })).toEqual([
      { vkSha256: 'v', pkSha256: 'p', ccsSha256: 'c', dumpSha256: 'd' },
    ])
  })

  it('allows test keys in a development build', () => {
    expect(zkPins({ ZK_KEYS_MANIFEST: manifest('test.json', { Test: true }) })).toHaveLength(1)
  })

  it('refuses test keys in a release build', () => {
    const path = manifest('test-release.json', { Test: true })
    expect(() => zkPins({ ZK_KEYS_MANIFEST: path, BUCKSPAY_RELEASE: '1' })).toThrow(/test keys/)
    expect(() => zkPins({ ZK_KEYS_MANIFEST: `${manifest('ok.json', {})},${path}`, BUCKSPAY_RELEASE: '1' })).toThrow(
      /test keys/,
    )
  })
})
