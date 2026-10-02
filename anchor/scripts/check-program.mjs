// Refuses a binary built for another cluster or program id before it is deployed:
// target/deploy/buckspay.so must carry the cluster's genesis hash, not another cluster's, and the
// program id of target/deploy/buckspay-keypair.json, the keypair `anchor program deploy` deploys to.
import { readFileSync } from 'node:fs'

const cluster = process.argv[2]
const read = (path) => readFileSync(new URL(path, import.meta.url))
const { clusters } = JSON.parse(read('../crates/protocol/tests/vectors/v1.json'))
if (!(cluster in clusters)) throw new Error(`usage: check-program.mjs <${Object.keys(clusters).join('|')}>`)
const program = read('../target/deploy/buckspay.so')
const programId = Buffer.from(JSON.parse(read('../target/deploy/buckspay-keypair.json')).slice(32))

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
if (!carries(programId))
  throw new Error('buckspay.so is built for another program id than target/deploy/buckspay-keypair.json')
console.log(`buckspay.so is a ${cluster} build for the program id of target/deploy/buckspay-keypair.json`)
