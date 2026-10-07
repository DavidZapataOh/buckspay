import {
  type Address,
  type Blockhash,
  createKeyPairFromPrivateKeyBytes,
  type GetAccountInfoApi,
  type GetTokenAccountsByOwnerApi,
  getAddressFromPublicKey,
  type Rpc,
  type GetLatestBlockhashApi,
} from '@solana/kit'
import type { RewardsGateway } from '../lock/gateway'
import { associatedTokenAddress } from '../lock/operations'
import type { NoteDb } from '../notes/db'
import type { JobAnswer } from './api'
import { loadLeafSecrets } from './secrets'
import type { SweepQuote } from './sweep-quote'
import { buildSweep, signSweep, TOKEN_PROGRAM } from './sweep'

const POLLS = 15
const POLL_MS = 2_000

/** What a sweep reads from the chain: the balance of a fresh address, whether the wallet has a token account, a blockhash. */
export type SweepChain = {
  balance(owner: Address): Promise<bigint>
  hasTokenAccount(owner: Address): Promise<boolean>
  blockhash(): Promise<{ blockhash: Blockhash; lastValidBlockHeight: bigint }>
}

export type MoveDeps = {
  db: NoteDb
  /** The connected wallet, which receives the rewards. */
  destination: Address
  mint: Address
  decimals: number
  chain: SweepChain
  quote: () => Promise<SweepQuote>
  gateway: Pick<RewardsGateway, 'submitSweep' | 'claimStatus'>
  sleep?: (ms: number) => Promise<void>
}

export function rpcSweepChain(
  rpc: Rpc<GetAccountInfoApi & GetTokenAccountsByOwnerApi & GetLatestBlockhashApi>,
  mint: Address,
): SweepChain {
  return {
    async balance(owner) {
      const { value } = await rpc
        .getTokenAccountsByOwner(owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' })
        .send()
      return value.reduce((total, { account }) => total + BigInt(account.data.parsed.info.tokenAmount.amount), 0n)
    },
    async hasTokenAccount(owner) {
      const account = await associatedTokenAddress(owner, mint, TOKEN_PROGRAM)
      const { value } = await rpc.getAccountInfo(account, { encoding: 'base64', commitment: 'confirmed' }).send()
      return value !== null
    },
    async blockhash() {
      return (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value
    },
  }
}

const REFUSED = (reason: string) => `The gateway refused to move the rewards (${reason}).`

async function settle(answer: JobAnswer, deps: MoveDeps): Promise<void> {
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let current = answer
  let job = answer.status === 'submitted' || answer.status === 'duplicate' ? answer.jobKey : undefined
  for (let poll = 0; poll < POLLS; poll++) {
    if (current.status === 'settled') return
    if (current.status === 'refused') throw new Error(REFUSED(current.reason))
    if (current.status === 'retry')
      throw new Error(`The gateway is busy. Try again in about ${Math.ceil(current.retryAfter / 60)} minutes.`)
    job = current.jobKey ?? job
    if (!job) throw new Error('The gateway did not say which job to watch.')
    await sleep(POLL_MS)
    current = await deps.gateway.claimStatus(job)
  }
  throw new Error('The move is still pending. Look again in a few minutes.')
}

/**
 * Moves what the claims paid out of the new addresses they went to: each address that holds a balance sends it to the
 * wallet in one transaction the gateway pays for, signed by that address alone, with the gateway's fee taken from the
 * amount. Whatever is left in an address is simply moved on the next try; nothing here needs a record of what moved.
 */
export async function moveRewards(deps: MoveDeps): Promise<{ moved: number; amount: bigint }> {
  const held = (await loadLeafSecrets(deps.db, ['claimed'])).filter((secret) => secret.recipientSecret)
  const failures: string[] = []
  let quote: SweepQuote | undefined
  let moved = 0
  let amount = 0n
  for (const secret of held) {
    try {
      const fresh = await createKeyPairFromPrivateKeyBytes(secret.recipientSecret!)
      const owner = await getAddressFromPublicKey(fresh.publicKey)
      const balance = await deps.chain.balance(owner)
      if (balance === 0n) continue
      quote ??= await deps.quote()
      const createsAccount = !(await deps.chain.hasTokenAccount(deps.destination))
      const fee = createsAccount ? quote.feeWithAccount : quote.fee
      if (balance <= fee) continue
      const message = await buildSweep({
        gateway: quote.gateway,
        fresh: owner,
        destinationOwner: deps.destination,
        mint: deps.mint,
        feeAccount: quote.feeAccount,
        decimals: deps.decimals,
        amount: balance - fee,
        fee,
        computeUnitLimit: quote.computeUnitLimit,
        computeUnitPrice: quote.computeUnitPrice,
        blockhash: await deps.chain.blockhash(),
        createsAccount,
      })
      await settle(await deps.gateway.submitSweep(await signSweep(message, fresh)), deps)
      moved += 1
      amount += balance - fee
    } catch (failure) {
      failures.push(failure instanceof Error ? failure.message : String(failure))
    }
  }
  if (failures.length > 0)
    throw new Error(failures.length === 1 ? failures[0] : `${failures[0]} (${failures.length} moves failed.)`)
  if (moved === 0) throw new Error('Nothing to move yet.')
  return { moved, amount }
}
