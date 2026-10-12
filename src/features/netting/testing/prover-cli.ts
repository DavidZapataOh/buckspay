import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { decodeStatement, type NettingStatement, publicInputs } from '../../../protocol'

/**
 * The real Groth16 prover through the `buckspay-zk` binary. The binary checks every proof it makes with gnark's
 * verifier before it prints it; `verify` accepts exactly the proofs it printed for the same public inputs.
 */
export function realProver(bin: string, keys: string) {
  const proved = new Map<string, string>()
  const keyOf = (statement: NettingStatement) => bytesToHex(concatBytes(...publicInputs(statement)))
  return {
    async prove(_session: Uint8Array, witness: Uint8Array): Promise<Uint8Array> {
      const dir = mkdtempSync(join(tmpdir(), 'netting-'))
      try {
        const file = join(dir, 'witness.bin')
        writeFileSync(file, witness)
        const raw = await new Promise<string>((resolve, reject) => {
          const child = spawn(bin, ['netting', 'prove', '--keys', keys, '--witness', file])
          let out = ''
          let err = ''
          child.stdout.on('data', (chunk) => (out += chunk))
          child.stderr.on('data', (chunk) => (err += chunk))
          child.on('error', reject)
          child.on('close', (code) =>
            code === 0 ? resolve(out.trim().split('\n').at(-1)!.trim()) : reject(new Error(`prover failed: ${err}`)),
          )
        })
        const statement = witnessStatement(witness)
        proved.set(keyOf(statement), raw)
        return hexToBytes(raw)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    async verify(statement: NettingStatement, proof: Uint8Array): Promise<boolean> {
      return proved.get(keyOf(statement)) === bytesToHex(proof)
    },
  }
}

const witnessStatement = (witness: Uint8Array) => decodeStatement(witness.slice(0, 111 + 32 * witness[66]))
