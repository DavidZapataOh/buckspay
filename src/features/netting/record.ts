import {
  type Address,
  appendTransactionMessageInstructions,
  type GetAccountInfoApi,
  type GetBlockTimeApi,
  type GetLatestBlockhashApi,
  type GetSignatureStatusesApi,
  type GetSignaturesForAddressApi,
  type GetTransactionApi,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Encoder,
  getU32Encoder,
  getU64Encoder,
  type Instruction,
  pipe,
  type Rpc,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
  type Signature,
  type TransactionError,
  type TransactionMessage,
  type TransactionMessageWithFeePayer,
  type TransactionSendingSigner,
  AccountRole,
  setTransactionMessageComputeUnitLimit,
} from '@solana/kit'
import {
  NETTING_DISCRIMINATOR as ACCOUNT_DISCRIMINATOR,
  getRecordNettingInstructionDataEncoder,
  RECORD_NETTING_DISCRIMINATOR,
} from '@project/anchor'
import { equalBytes } from '@noble/curves/utils.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { DEVNET_GENESIS_HASH, domain, MAINNET_GENESIS_HASH, Purpose } from '../../protocol'
import { ACTIVE_PROFILE } from '../../protocol/active-profile'
import {
  decodeStatement,
  type NettingStatement,
  nettingAddress,
  statementContent,
  statementEnvelope,
} from '../../protocol/netting'
import { BUILD_GATEWAY_URL, GATEWAY_TIMEOUT_MS, GatewayError } from '../lock/gateway'
import { waitForSignature } from '../lock/perform'

/** The wallet that signs and sends, as the lock operations use it. */
export type WalletSigner = TransactionSendingSigner

export type FetchDeps = { url?: string; fetch?: typeof fetch }

/** The gateway refused the netting; `reason` is its word for why. */
export class NettingRefused extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.name = 'NettingRefused'
    this.reason = reason
  }
}

/** The wallet does not sign version 1 transactions and the netting has more than two participants. */
export class WalletRefusedV1 extends Error {
  constructor() {
    super('The wallet does not sign version 1 transactions.')
    this.name = 'WalletRefusedV1'
  }
}

/** The quote ran out before it was paid. */
export class QuoteExpired extends Error {
  constructor() {
    super('The record fee quote expired.')
    this.name = 'QuoteExpired'
  }
}

/** How long a record outlives its statement: inside `[expires, expires + KEEP)` an absent account means void. */
export const NETTING_KEEP_SECS = ACTIVE_PROFILE.name === 'short' ? 120 : 30 * 86_400

/** The discriminator of the `Netting` account. */
export const NETTING_DISCRIMINATOR = Uint8Array.from(ACCOUNT_DISCRIMINATOR)

const RECORD_ACCOUNT_LEN = 48
const U32_MAX = 0xffffffff
const SYSTEM_PROGRAM = '11111111111111111111111111111111' as Address
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' as Address
const ED25519_PROGRAM = 'Ed25519SigVerify111111111111111111111111111' as Address
const INSTRUCTIONS_SYSVAR = 'Sysvar1nstructions1111111111111111111111111' as Address
const RECORD_COMPUTE_UNITS = 200_000
const HISTORY_PAGE = 1_000
const HISTORY_PARALLEL = 8

type Cluster = 'devnet' | 'mainnet'
const GENESIS = { devnet: DEVNET_GENESIS_HASH, mainnet: MAINNET_GENESIS_HASH }

function gatewayUrl(deps: FetchDeps): string {
  const url = deps.url ?? BUILD_GATEWAY_URL
  if (!url) throw new Error('This build has no gateway.')
  return url
}

/** One request to the gateway: the status and the JSON body, whatever the status. */
export async function call(
  deps: FetchDeps,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS)
  try {
    const response = await (deps.fetch ?? fetch)(`${gatewayUrl(deps)}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const json = await response.json().catch(() => null)
    return { status: response.status, json: json && typeof json === 'object' ? json : {} }
  } finally {
    clearTimeout(timeout)
  }
}

export const refusal = (status: number, json: Record<string, unknown>) =>
  new GatewayError(status, typeof json.error === 'string' ? json.error : `HTTP ${status}`, json)

/**
 * Sends a netting to the gateway to record. `202` means the transaction was sent and its outcome is unknown, so
 * a result never says the netting is recorded: only `nettingOutcome` does. With `payment` the gateway uses the paid lane.
 */
export async function submitNetting(
  statement: Uint8Array,
  signatures: Uint8Array[],
  proof: Uint8Array,
  payment?: string,
  deps: FetchDeps = {},
): Promise<{ signature: string; pending: boolean } | { recorded: true } | { capped: true }> {
  const { status, json } = await call(deps, '/v1/nettings', {
    statement: bytesToHex(statement),
    signatures: signatures.map(bytesToHex),
    proof: bytesToHex(proof),
    payment,
  })
  if (status === 200 || status === 202) return { signature: String(json.signature), pending: status === 202 }
  if (status === 409) return { recorded: true }
  if (status === 429) return { capped: true }
  if (status === 400) throw new NettingRefused(String(json.reason ?? json.error ?? 'refused'))
  throw refusal(status, json)
}

/** What the gateway asks to record a netting for a member who is over the free cap. */
export type RecordQuote = {
  quoteId: string
  lamports: bigint
  sponsor: Address
  /** Unix seconds by the gateway's clock. */
  expiresAt: number
}

const issued = new WeakMap<RecordQuote, { gatewayNow: number; receivedAt: number }>()

export async function quoteNettingRecord(deps: FetchDeps = {}): Promise<RecordQuote> {
  const { status, json } = await call(deps, '/v1/nettings/quote')
  if (status !== 200) throw refusal(status, json)
  const quote: RecordQuote = {
    quoteId: String(json.quoteId),
    lamports: BigInt(json.lamports as number | string),
    sponsor: json.sponsor as Address,
    expiresAt: Number(json.expiresAt),
  }
  if (typeof json.now === 'number') issued.set(quote, { gatewayNow: json.now, receivedAt: performance.now() })
  return quote
}

export type RpcDeps = {
  rpc?: Rpc<GetLatestBlockhashApi & GetSignatureStatusesApi>
  /** Sends the built message through the wallet and returns its signature. */
  send?: (message: TransactionMessage & TransactionMessageWithFeePayer) => Promise<string>
  /** `null` when `signature` succeeded, the error when it failed, `undefined` when it was not confirmed in time. */
  confirm?: (signature: string) => Promise<TransactionError | null | undefined>
  programId?: Address
  payer?: Address
  cluster?: Cluster
}

const transfer = (from: Address, to: Address, lamports: bigint): Instruction => ({
  programAddress: SYSTEM_PROGRAM,
  accounts: [
    { address: from, role: AccountRole.WRITABLE_SIGNER },
    { address: to, role: AccountRole.WRITABLE },
  ],
  data: Uint8Array.from([...getU32Encoder().encode(2), ...getU64Encoder().encode(lamports)]),
})

const memo = (text: string): Instruction => ({ programAddress: MEMO_PROGRAM, data: utf8ToBytes(text) })

const v0 = (payer: Address, instructions: Instruction[]) =>
  pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )

function walletSend(wallet: WalletSigner, rpc: NonNullable<RpcDeps['rpc']>) {
  return async (message: TransactionMessage & TransactionMessageWithFeePayer) => {
    const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
    const ready = pipe(
      message,
      (m) => setTransactionMessageFeePayerSigner(wallet, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(value, m),
    )
    return getBase58Decoder().decode(await signAndSendTransactionMessageWithSigners(ready))
  }
}

function sender(wallet: WalletSigner, deps: RpcDeps) {
  const rpc = deps.rpc
  return {
    send: deps.send ?? (rpc ? walletSend(wallet, rpc) : undefined),
    confirm: deps.confirm ?? (rpc ? (signature: string) => waitForSignature(rpc, signature) : undefined),
  }
}

async function sendAndConfirm(
  wallet: WalletSigner,
  message: TransactionMessage & TransactionMessageWithFeePayer,
  deps: RpcDeps,
): Promise<string> {
  const { send, confirm } = sender(wallet, deps)
  if (!send || !confirm) throw new Error('An RPC connection is needed to send.')
  const signature = await send(message)
  const failure = await confirm(signature)
  if (failure === undefined) throw new Error('The transaction was not confirmed in time.')
  if (failure !== null) throw new Error('The transaction failed.')
  return signature
}

/**
 * The paid lane: the wallet signs a v0 transaction of a transfer to the sponsor and a memo that binds the payment
 * to the content and the quote it answers. Returns its signature once confirmed.
 */
export async function payNettingRecord(
  wallet: WalletSigner,
  content: Uint8Array,
  quote: RecordQuote,
  deps: RpcDeps = {},
): Promise<string> {
  const stamp = issued.get(quote)
  if (stamp && stamp.gatewayNow + (performance.now() - stamp.receivedAt) / 1000 >= quote.expiresAt) {
    throw new QuoteExpired()
  }
  const message = v0(wallet.address, [
    transfer(wallet.address, quote.sponsor, quote.lamports),
    memo(`${bytesToHex(content)}:${quote.quoteId}`),
  ])
  return sendAndConfirm(wallet, message, deps)
}

const programBytes = (programId: Address) => Uint8Array.from(getAddressEncoder().encode(programId))
const addressOf = (bytes: Uint8Array) => getAddressDecoder().decode(bytes)

function ed25519Instruction(statement: NettingStatement, signatures: Uint8Array[], message: Uint8Array): Instruction {
  const n = statement.participants
  if (signatures.length !== n || signatures.some((s) => s.length !== 64))
    throw new RangeError('one signature per participant')
  const base = 2 + 14 * n
  const entry = 32 + 64
  const messageAt = base + entry * n
  const data = new Uint8Array(messageAt + message.length)
  const view = new DataView(data.buffer)
  data[0] = n
  for (let i = 0; i < n; i++) {
    const key = base + entry * i
    const fields = [key + 32, 0xffff, key, 0xffff, messageAt, message.length, 0xffff]
    fields.forEach((field, k) => view.setUint16(2 + 14 * i + 2 * k, field, true))
    data.set(statement.ephemeral[i], key)
    data.set(signatures[i], key + 32)
  }
  data.set(message, messageAt)
  return { programAddress: ED25519_PROGRAM, data }
}

/**
 * The two instructions that record a netting, in the order the program reads them: the Ed25519 verification of
 * every participant's signature, then `record_netting`.
 */
export function nettingInstructions(
  programId: Address,
  payer: Address,
  statement: Uint8Array,
  signatures: Uint8Array[],
  proof: Uint8Array,
  cluster: Cluster = 'devnet',
): Instruction[] {
  const decoded = decodeStatement(statement)
  const program = programBytes(programId)
  const record = nettingAddress(program, statementContent(decoded))
  if (!record) throw new RangeError('The record address of this statement is on the curve.')
  const message = statementEnvelope(decoded, domain(Purpose.Netting, GENESIS[cluster], program))
  return [
    ed25519Instruction(decoded, signatures, message),
    {
      programAddress: programId,
      accounts: [
        { address: payer, role: AccountRole.WRITABLE_SIGNER },
        { address: addressOf(record), role: AccountRole.WRITABLE },
        { address: INSTRUCTIONS_SYSVAR, role: AccountRole.READONLY },
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      ],
      data: Uint8Array.from(getRecordNettingInstructionDataEncoder().encode({ statement, proof })),
    },
  ]
}

const REFUSED_V1 = /version|unsupported/i

/**
 * The member pays for the record from its wallet: a version 1 transaction first. A wallet that does not sign
 * version 1 gets the same instructions as a v0 transaction when there are two participants (it fits in 1,232 bytes);
 * for more the record waits for the sponsor.
 */
export async function recordNettingPaying(
  wallet: WalletSigner,
  statement: Uint8Array,
  signatures: Uint8Array[],
  proof: Uint8Array,
  deps: RpcDeps = {},
): Promise<{ signature: string }> {
  const payer = deps.payer ?? wallet.address
  const programId = deps.programId ?? (ACTIVE_PROFILE.programId as Address)
  const instructions = nettingInstructions(programId, payer, statement, signatures, proof, deps.cluster)
  const v1 = pipe(
    // kit builds version 1 messages but does not type them in createTransactionMessage yet
    Object.freeze({ version: 1, instructions: Object.freeze([]) }) as unknown as TransactionMessage,
    (m) => setTransactionMessageFeePayer(payer, m),
    (m) => setTransactionMessageComputeUnitLimit(RECORD_COMPUTE_UNITS, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  try {
    return { signature: await sendAndConfirm(wallet, v1, deps) }
  } catch (error) {
    if (!(error instanceof Error) || !REFUSED_V1.test(error.message)) throw error
  }
  if (decodeStatement(statement).participants > 2) throw new WalletRefusedV1()
  const fallback = pipe(v0(payer, instructions), (m) => setTransactionMessageComputeUnitLimit(RECORD_COMPUTE_UNITS, m))
  return { signature: await sendAndConfirm(wallet, fallback, deps) }
}

/** An account as a finalized read returns it: `owner` and `data` are absent when the account does not exist. */
export type AccountRead = { slot: bigint; owner?: Uint8Array; data?: Uint8Array }

export type HistoryEntry = { signature: string; blockTime: number; ok: boolean; recordsNetting: boolean }

/** Every read is at finalized commitment. */
export type ChainReads = {
  account(address: Address, commitment: 'finalized'): Promise<AccountRead>
  blockTime(slot: bigint): Promise<number>
  /** One page of the address's signatures, newest first, at most 1,000. */
  history(address: Address, before?: string): Promise<HistoryEntry[]>
}

export type OutcomeDeps = { reads: ChainReads; programId?: Uint8Array }

export type NettingOutcome = 'recorded' | 'void' | 'pending' | 'undecided'

/** A record only if the program owns it, it has 48 bytes, the `Netting` discriminator and `closable_at = expires + KEEP`. */
export function isNettingRecord(
  account: { owner?: Uint8Array; data?: Uint8Array } | null,
  statement: NettingStatement,
  programId: Uint8Array,
): boolean {
  if (!account?.owner || !account.data) return false
  const { owner, data } = account
  if (!equalBytes(owner, programId) || data.length !== RECORD_ACCOUNT_LEN) return false
  if (!equalBytes(data.subarray(0, 8), NETTING_DISCRIMINATOR)) return false
  const closableAt = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(44, true)
  return closableAt === Math.min(statement.expires + NETTING_KEEP_SECS, U32_MAX)
}

/**
 * One finalized reading of a statement: a record is `recorded`; no record before `expires` is `pending`; none
 * inside `[expires, expires + KEEP)` is `void`; later the signature history is read back to before `expires`, and a
 * successful `record_netting` on the address is `recorded`, none is `void`, an unreadable history is `undecided`.
 * `slot` is the slot of the read.
 */
export async function nettingReading(
  statement: NettingStatement,
  deps: OutcomeDeps,
): Promise<{ outcome: NettingOutcome; slot: bigint }> {
  const program = deps.programId ?? programBytes(ACTIVE_PROFILE.programId as Address)
  const record = nettingAddress(program, statementContent(statement))
  if (!record) throw new RangeError('The record address of this statement is on the curve.')
  const where = addressOf(record)
  const read = await deps.reads.account(where, 'finalized')
  const { slot } = read
  if (isNettingRecord(read, statement, program)) return { outcome: 'recorded', slot }
  const time = await deps.reads.blockTime(slot)
  if (time < statement.expires) return { outcome: 'pending', slot }
  if (time < statement.expires + NETTING_KEEP_SECS) return { outcome: 'void', slot }
  let before: string | undefined
  for (;;) {
    const page = await deps.reads.history(where, before)
    if (page.length === 0) return { outcome: 'undecided', slot }
    if (page.some((entry) => entry.ok && entry.recordsNetting)) return { outcome: 'recorded', slot }
    if (page.some((entry) => entry.blockTime < statement.expires)) return { outcome: 'void', slot }
    before = page[page.length - 1].signature
  }
}

/**
 * The reading's outcome, except that `void` needs an earlier void reading at a lower slot (`voidSeenAt`, kept by
 * the caller's sweep); a first void reading is `pending`. Never reads the phone clock.
 */
export async function nettingOutcome(
  statement: NettingStatement,
  deps: OutcomeDeps & { voidSeenAt?: bigint },
): Promise<NettingOutcome> {
  const { outcome, slot } = await nettingReading(statement, deps)
  if (outcome !== 'void') return outcome
  return deps.voidSeenAt !== undefined && slot > deps.voidSeenAt ? 'void' : 'pending'
}

type ReadRpc = Rpc<GetAccountInfoApi & GetBlockTimeApi & GetSignaturesForAddressApi & GetTransactionApi>

/** Chain reads over an RPC connection, all at finalized commitment. */
export function createChainReads(rpc: ReadRpc, programId: Address): ChainReads {
  const base64 = getBase64Encoder()
  const base58 = getBase58Encoder()
  const recordsNettingOn = async (signature: Signature, where: Address) => {
    const tx = await rpc
      .getTransaction(signature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 })
      .send()
    if (!tx || tx.meta?.err) return false
    const keys = [
      ...tx.transaction.message.accountKeys,
      ...(tx.meta?.loadedAddresses?.writable ?? []),
      ...(tx.meta?.loadedAddresses?.readonly ?? []),
    ]
    const target = keys.indexOf(where)
    return tx.transaction.message.instructions.some(
      (ix) =>
        keys[ix.programIdIndex] === programId &&
        ix.accounts.includes(target) &&
        equalBytes(
          Uint8Array.from(base58.encode(ix.data)).subarray(0, 8),
          Uint8Array.from(RECORD_NETTING_DISCRIMINATOR),
        ),
    )
  }
  return {
    async account(where, commitment) {
      const { context, value } = await rpc.getAccountInfo(where, { commitment, encoding: 'base64' }).send()
      if (!value) return { slot: context.slot }
      return {
        slot: context.slot,
        owner: programBytes(value.owner),
        data: Uint8Array.from(base64.encode(value.data[0])),
      }
    },
    async blockTime(slot) {
      const time = await rpc.getBlockTime(slot).send()
      if (time === null) throw new Error('The block time is not available.')
      return Number(time)
    },
    async history(where, before) {
      const page = await rpc
        .getSignaturesForAddress(where, {
          before: before as Signature | undefined,
          limit: HISTORY_PAGE,
          commitment: 'finalized',
        })
        .send()
      const entries: HistoryEntry[] = []
      for (let at = 0; at < page.length; at += HISTORY_PARALLEL) {
        entries.push(
          ...(await Promise.all(
            page.slice(at, at + HISTORY_PARALLEL).map(async (item) => {
              const ok = item.err === null
              return {
                signature: item.signature,
                blockTime: item.blockTime === null ? Number.POSITIVE_INFINITY : Number(item.blockTime),
                ok,
                recordsNetting: ok && (await recordsNettingOn(item.signature, where)),
              }
            }),
          )),
        )
      }
      return entries
    },
  }
}
