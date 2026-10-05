// A faucet of a test token for the end-to-end flows on a local validator. It creates a mint of 6
// decimals at a fixed address (the one the app and the gateway are configured with) and, for each
// wallet address POSTed to it, mints 100 tokens into the wallet's associated token account.
//
//   node .maestro/scripts/usdc-faucet.mjs --print-mint   # the mint address, for the build and the gateway
//   node .maestro/scripts/usdc-faucet.mjs                # serve until stopped
//
// RPC_URL (default http://localhost:8899) and PORT (default 8898) configure it.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  isAddress,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit'

const RPC_URL = process.env.RPC_URL ?? 'http://localhost:8899'
const PORT = Number(process.env.PORT ?? 8898)
const DECIMALS = 6
const MINT_SIZE = 82n
const GRANT = 100n * 10n ** BigInt(DECIMALS)
const SYSTEM = address('11111111111111111111111111111111')
const TOKEN = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ASSOCIATED_TOKEN = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

// Keys of a local validator only: the seeds are public, so the mint address is the same every run.
const keyFor = (label) =>
  createKeyPairSignerFromPrivateKeyBytes(createHash('sha256').update(`buckspay local ${label}`).digest())
const [payer, mint] = await Promise.all([keyFor('faucet payer'), keyFor('funding token mint')])

if (process.argv.includes('--print-mint')) {
  console.log(mint.address)
  process.exit(0)
}

const rpc = createSolanaRpc(RPC_URL)
const encoder = getAddressEncoder()
const u64 = (value) => new Uint8Array(new BigUint64Array([value]).buffer)

async function confirmed(signature) {
  for (let i = 0; i < 60; i++) {
    const {
      value: [status],
    } = await rpc.getSignatureStatuses([signature]).send()
    if (status?.err)
      throw new Error(
        `transaction failed: ${JSON.stringify(status.err, (_, v) => (typeof v === 'bigint' ? Number(v) : v))}`,
      )
    if (status && status.confirmationStatus !== 'processed') return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`transaction ${signature} was not confirmed`)
}

async function send(instructions) {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const transaction = await signTransactionMessageWithSigners(message)
  await rpc.sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: 'base64' }).send()
  await confirmed(getSignatureFromTransaction(transaction))
}

async function ensureMint() {
  if ((await rpc.getAccountInfo(mint.address, { commitment: 'confirmed', encoding: 'base64' }).send()).value) return
  await confirmed(await rpc.requestAirdrop(payer.address, lamports(10_000_000_000n)).send())
  const rent = await rpc.getMinimumBalanceForRentExemption(MINT_SIZE).send()
  await send([
    {
      programAddress: SYSTEM,
      accounts: [
        { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
        { address: mint.address, role: AccountRole.WRITABLE_SIGNER, signer: mint },
      ],
      data: Uint8Array.from([0, 0, 0, 0, ...u64(rent), ...u64(MINT_SIZE), ...encoder.encode(TOKEN)]),
    },
    {
      programAddress: TOKEN,
      accounts: [{ address: mint.address, role: AccountRole.WRITABLE }],
      data: Uint8Array.from([20, DECIMALS, ...encoder.encode(payer.address), 0]),
    },
  ])
}

async function grant(wallet) {
  const [account] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN,
    seeds: [encoder.encode(wallet), encoder.encode(TOKEN), encoder.encode(mint.address)],
  })
  await send([
    {
      programAddress: ASSOCIATED_TOKEN,
      accounts: [
        { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
        { address: account, role: AccountRole.WRITABLE },
        { address: wallet, role: AccountRole.READONLY },
        { address: mint.address, role: AccountRole.READONLY },
        { address: SYSTEM, role: AccountRole.READONLY },
        { address: TOKEN, role: AccountRole.READONLY },
      ],
      data: Uint8Array.from([1]),
    },
    {
      programAddress: TOKEN,
      accounts: [
        { address: mint.address, role: AccountRole.WRITABLE },
        { address: account, role: AccountRole.WRITABLE },
        { address: payer.address, role: AccountRole.READONLY_SIGNER, signer: payer },
      ],
      data: Uint8Array.from([7, ...u64(GRANT)]),
    },
  ])
  return account
}

await ensureMint()
createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  const wallet = body.trim()
  if (!isAddress(wallet)) {
    response.writeHead(400).end(`not an address: ${wallet}`)
    return
  }
  try {
    response.writeHead(200).end(await grant(address(wallet)))
  } catch (error) {
    response.writeHead(500).end(String(error))
  }
}).listen(PORT, '127.0.0.1', () => console.log(`funding token ${mint.address} on ${RPC_URL}, faucet on :${PORT}`))
