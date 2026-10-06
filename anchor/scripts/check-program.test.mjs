// Builds synthetic program binaries (random bytes with the right constants embedded) and checks every
// pairing of cluster and profile. The real binaries are checked the same way in CI after both builds.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function toBase58(bytes) {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'))
  let out = ''
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out
    n /= 58n
  }
  return out
}

const devnetGenesis = randomBytes(32),
  mainnetGenesis = randomBytes(32)
const pilotDevnet = randomBytes(32),
  pilotMainnet = randomBytes(32),
  shortId = randomBytes(32)
const dir = mkdtempSync(join(tmpdir(), 'check-program-'))
const vectors = join(dir, 'v1.json')
writeFileSync(
  vectors,
  JSON.stringify({
    clusters: { devnet: devnetGenesis.toString('hex'), mainnet: mainnetGenesis.toString('hex') },
    profiles: {
      production: { programIds: { devnet: toBase58(pilotDevnet), mainnet: toBase58(pilotMainnet) } },
      short: { programId: toBase58(shortId) },
    },
  }),
)

const [prodVk, testVk] = [randomBytes(32), randomBytes(32)]
const zkDir = join(dir, 'zk')
mkdirSync(zkDir)
writeFileSync(join(zkDir, 'manifest.json'), JSON.stringify({ VKSHA256: prodVk.toString('hex') }))
writeFileSync(join(zkDir, 'manifest.test.json'), JSON.stringify({ VKSHA256: testVk.toString('hex') }))

/** A binary: filler, then the constants given; one of them split into four immediates to cover that encoding. */
function binary(constants, { split = [], vk = prodVk } = {}) {
  constants = vk ? [...constants, vk] : constants
  const parts = [randomBytes(2048)]
  for (const c of constants) {
    if (split.includes(c)) {
      for (const at of [0, 8, 16, 24])
        parts.push(randomBytes(4), c.subarray(at, at + 4), Buffer.alloc(4), c.subarray(at + 4, at + 8), randomBytes(8))
    } else parts.push(c, randomBytes(16))
  }
  writeFileSync(join(dir, 'buckspay.so'), Buffer.concat(parts))
}
const run = (cluster, profile) => {
  try {
    execFileSync('node', [new URL('./check-program.mjs', import.meta.url).pathname, cluster, profile], {
      env: { ...process.env, BUCKSPAY_DEPLOY_DIR: dir, BUCKSPAY_VECTORS: vectors, BUCKSPAY_ZK_DIR: zkDir },
      stdio: 'pipe',
    })
    return 'ok'
  } catch (e) {
    return (
      e.stderr
        .toString()
        .split('\n')
        .find((l) => l.startsWith('Error:')) ?? e.message
    )
  }
}

test('a production devnet build passes only as production devnet', () => {
  binary([devnetGenesis, pilotDevnet])
  assert.equal(run('devnet', 'production'), 'ok')
  assert.match(run('devnet', 'short'), /not a short build/)
  assert.match(run('mainnet', 'production'), /not a mainnet build/)
})

test('a short-windows build passes only as short, and only on devnet', () => {
  binary([devnetGenesis, shortId], { split: [shortId] })
  assert.equal(run('devnet', 'short'), 'ok')
  assert.match(run('devnet', 'production'), /not a production build/)
  assert.match(run('mainnet', 'short'), /devnet only/)
})

test('a binary carrying both program ids is refused in either profile', () => {
  binary([devnetGenesis, pilotDevnet, shortId])
  assert.match(run('devnet', 'production'), /carries the short program id/)
  assert.match(run('devnet', 'short'), /carries the production program id/)
})

test('a binary of the other cluster is refused', () => {
  binary([mainnetGenesis, pilotMainnet])
  assert.match(run('devnet', 'production'), /not a devnet build/)
  assert.equal(run('mainnet', 'production'), 'ok')
})

test('immediates-encoded constants are found', () => {
  binary([devnetGenesis, pilotDevnet], { split: [devnetGenesis, pilotDevnet] })
  assert.equal(run('devnet', 'production'), 'ok')
})

test('an unknown profile and a missing id fail loudly', () => {
  binary([devnetGenesis])
  assert.match(run('devnet', 'staging'), /unknown profile/)
  assert.match(run('devnet', 'production'), /lacks the production program id/)
})

test('the verifying key of a throwaway ceremony is refused on mainnet and a missing key everywhere', () => {
  binary([mainnetGenesis, pilotMainnet], { vk: prodVk })
  assert.equal(run('mainnet', 'production'), 'ok')
  binary([mainnetGenesis, pilotMainnet, testVk])
  assert.match(run('mainnet', 'production'), /throwaway ceremony/)
  binary([mainnetGenesis, pilotMainnet], { vk: null })
  assert.match(run('mainnet', 'production'), /does not carry the verifying key/)
  binary([devnetGenesis, pilotDevnet], { vk: testVk })
  assert.equal(run('devnet', 'production'), 'ok')
})
