// Refuses a binary that does not belong where it is going, before it is deployed.
//   check-program.mjs <cluster> [profile]      cluster: devnet | mainnet; profile: production (default) | short
// The binary must carry the genesis hash of its own cluster and no other, and the program id of its own
// profile and none of the other profile's. Program ids and genesis hashes are 32-byte constants, which
// survive compilation (stored whole, or as four 64-bit immediates). The short-windows profile has its
// own program id, so a build with shortened windows cannot be mistaken for the pilot's program.
import { readFileSync } from 'node:fs'

const [cluster, profile = 'production'] = process.argv.slice(2)
const here = (path) => new URL(path, import.meta.url)
const deployDir = process.env.BUCKSPAY_DEPLOY_DIR ?? new URL('../target/deploy/', import.meta.url).pathname
const vectorsPath = process.env.BUCKSPAY_VECTORS ?? here('../crates/protocol/tests/vectors/v1.json').pathname
const { clusters, profiles } = JSON.parse(readFileSync(vectorsPath))

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58(text) {
  let n = 0n
  for (const c of text) n = n * 58n + BigInt(ALPHABET.indexOf(c))
  const hex = n.toString(16).padStart(64, '0')
  return Buffer.from(hex, 'hex')
}

if (!(cluster in clusters))
  throw new Error(`usage: check-program.mjs <${Object.keys(clusters).join('|')}> [production|short]`)
if (!(profile in profiles)) throw new Error(`unknown profile ${profile}; known: ${Object.keys(profiles).join(', ')}`)
if (profile === 'short' && cluster !== 'devnet') throw new Error('the short-windows profile exists on devnet only')

const program = readFileSync(`${deployDir}/buckspay.so`)
const keypairId = (file) => Buffer.from(JSON.parse(readFileSync(`${deployDir}/${file}`)).slice(32))
const ids = {
  production: profiles.production.programIds[cluster]
    ? base58(profiles.production.programIds[cluster])
    : keypairId('buckspay-keypair.json'),
  short: base58(profiles.short.programId),
}

// A 32-byte constant is in read-only data, or loaded as four 64-bit immediates: each one an `lddw`,
// whose two 8-byte slots carry its low and high 32 bits at their offset 4.
function carries(bytes) {
  if (program.includes(bytes)) return true
  return [0, 8, 16, 24].every((at) =>
    program.includes(Buffer.concat([bytes.subarray(at, at + 4), Buffer.alloc(4), bytes.subarray(at + 4, at + 8)])),
  )
}

for (const [name, hash] of Object.entries(clusters)) {
  if (carries(Buffer.from(hash, 'hex')) !== (name === cluster)) {
    throw new Error(
      `buckspay.so is not a ${cluster} build: it ${name === cluster ? 'lacks' : 'carries'} the ${name} genesis hash`,
    )
  }
}
for (const [name, id] of Object.entries(ids)) {
  if (carries(id) !== (name === profile)) {
    throw new Error(
      `buckspay.so is not a ${profile} build: it ${name === profile ? 'lacks' : 'carries'} the ${name} program id`,
    )
  }
}
console.log(`buckspay.so is a ${cluster} ${profile} build`)
