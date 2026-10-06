import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js'
import {
  type Address,
  type GetAccountInfoApi,
  type GetBlockTimeApi,
  type GetSignaturesForAddressApi,
  type GetTransactionApi,
  getAddressDecoder,
  getBase58Decoder,
  type Rpc,
} from '@solana/kit'
import { vi } from 'vitest'
import { getSettleNoteInstructionDataEncoder } from '@project/anchor'
import { decodeBundle, type PaymentRequest } from '../../payment/messages'
import { confirmAndSend } from '../../payment/pay'
import { type PayContext, planPayment } from '../../payment/preflight'
import { createSoftSigner } from '../../payment/testing/soft-guard'
import { ATTESTER, NOTE_DOMAIN, NOW, type Party, party, payCtx, PROGRAM, signIssue } from '../../payment/testing/world'
import { encodeIssueBody, GRACE, type Issue, ScopeKind } from '../../protocol'
import { ACTIVE_PROFILE } from '../../protocol/active-profile'
import { associatedTokenAddress } from '../lock/operations'
import { BUILD_MINT_BYTES } from '../pay/tokens'
import type { Outcome } from '../settlement/settle'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { type OutboxRow, outboxFor } from '../relay/outbox'
import type { RelayAnswer } from '../relay/seal'
import { sealRelay } from '../relay/seal'
import { handOffRow } from '../relay/outbox'
import {
  fakeL2cap,
  openAsGateway,
  parseInner,
  rememberSecret,
  seen,
  sealedFixture,
  testGatewayKey,
} from '../relay/testing'
import { applyEvent, reservedAmount } from './track'
import type { RemoteEvent, RemoteState } from './delivery'
import type { PayLink } from './pay-link'
import { remoteRequest } from './plan'
import { TOKEN_PROGRAM } from './token-account'

export const USDC = BUILD_MINT_BYTES
export const OTHER_MINT = new Uint8Array(32).fill(0x66)
export const PROGRAM_FOR_TESTS = PROGRAM
export const link: PayLink = { wallet: new Uint8Array(32).fill(5), mint: USDC, name: 'Ana' }

const GENEROUS = 1_000_000_000n

const usdcContext = (me: Party, bond: bigint): PayContext => {
  const base = payCtx(me, { bond })
  return {
    ...base,
    locks: base.locks.map((lock) => ({ ...lock, mint: USDC })),
    tokens: new Map([[bytesToHex(USDC), { symbol: 'USDC', decimals: 6 }]]),
  }
}

/** The executed planner over a lock of `bond`; throws the refusal it gives, so a failing bond rule shows as an error. */
export function planWithBond(request: PaymentRequest, { bond }: { bond: bigint }) {
  const planned = planPayment(request, usdcContext(party(1), bond))
  if (!planned.ok) throw new Error(planned.reason)
  return planned.plan
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const address = (bytes: Uint8Array) => getAddressDecoder().decode(bytes)

/** What a `Spent` account holds: the discriminator, the content, the payer, two times and the flags. */
const spentData = (record: { content: Uint8Array; flags: number }) =>
  concatBytes(new Uint8Array(8), record.content, new Uint8Array(32), new Uint8Array(8), Uint8Array.of(record.flags))

/** A finalized-read RPC that answers one record and the block times of its slots, and remembers the commitments it was asked. */
export function fakeChainRpc(o: {
  record: { content: Uint8Array; flags: number; owner?: Uint8Array } | null
  slotBlockTime?: number
  slotBlockTimes?: (number | null)[]
}) {
  const asked: string[] = []
  let call = 0
  const rpc = {
    getAccountInfo: (_address: Address, config: { commitment: string }) => ({
      send: async () => {
        asked.push(config.commitment)
        return {
          context: { slot: 5n },
          value: o.record
            ? {
                owner: address(o.record.owner ?? PROGRAM),
                data: [toBase64(spentData(o.record)), 'base64'],
                lamports: 1n,
              }
            : null,
        }
      },
    }),
    getBlockTime: () => ({
      send: async () => {
        const times = o.slotBlockTimes ?? [o.slotBlockTime ?? null]
        const time = times[Math.min(call++, times.length - 1)]
        return time === null ? null : BigInt(time)
      },
    }),
    commitments: () => asked,
  }
  return rpc as unknown as Rpc<GetAccountInfoApi & GetBlockTimeApi> & { commitments(): string[] }
}

/** An outbox row of a remote payment as the app keeps it. */
export function outboxRow(o: { expiry: number }): OutboxRow {
  const blob = sealedFixture(3).blob
  return {
    id: sha256(blob),
    kind: 'remote',
    ref: bytesToHex(new Uint8Array(32).fill(3)),
    blob,
    secret: new Uint8Array(32).fill(2),
    clusterTag: new Uint8Array(4),
    storedBy: 0,
    answer: null,
    nextHandAt: 0,
    createdAt: 0,
    expiresAt: o.expiry + GRACE,
    copiesLeft: 8,
    state: 'signed',
    messageId: new Uint8Array(32).fill(4),
    content: new Uint8Array(32).fill(7),
    conflict: false,
  }
}

/** An RPC that knows the mint and, or not, the friend's token account; `fails` makes every read throw. */
export function fakeAccountRpc(o: { exists: boolean; fails?: boolean }) {
  return {
    getAccountInfo: (target: Address) => ({
      send: async () => {
        if (o.fails) throw new Error('offline')
        const account = { owner: TOKEN_PROGRAM, data: [toBase64(new Uint8Array(82)), 'base64'], lamports: 1n }
        return { context: { slot: 5n }, value: target === address(USDC) || o.exists ? account : null }
      },
    }),
  } as unknown as Rpc<GetAccountInfoApi>
}

export type SignedRemote = Awaited<ReturnType<ReturnType<typeof remoteWorld>['signed']>>

/** A payer's phone, online or not, with a real signed payment to `link`, a note store and a gateway that opens what is sealed to it. */
export function remoteWorld({ online, outcome }: { online: boolean; outcome?: Outcome }) {
  const db = createNodeDb()
  const settleDirect = vi.fn(async () => outcome ?? ({ kind: 'sent', signature: 'sig' } as Outcome))
  const ready = migrate(db)
  const now = () => testGatewayKey.now
  const ctx = {
    db,
    online,
    now,
    noteDomain: NOTE_DOMAIN,
    settleDirect,
    seal: (inner: Uint8Array, at: number) => sealRelay(testGatewayKey.config, testGatewayKey.genesis, inner, at),
  }
  const only = async () => {
    const [row] = await db.all<{ ref: string }>('SELECT ref FROM relay_outbox')
    const found = await outboxFor(db, row.ref)
    if (!found) throw new Error('nothing was queued')
    return found
  }
  return {
    db,
    ctx,
    settleDirect,
    async signed(amount: bigint) {
      await ready
      const request = remoteRequest(link, amount, '', { now: NOW, attesters: [ATTESTER.id] })
      const plan = planWithBond(request, { bond: GENEROUS })
      let bundle: Uint8Array = new Uint8Array(0)
      const sent = await confirmAndSend(plan, request, 'remote', {
        db,
        sign: createSoftSigner(party(1)).sign,
        transport: {
          send: async (message) => {
            bundle = message.payload
          },
        },
        authenticate: async () => true,
        noteDomain: NOTE_DOMAIN,
        now: () => NOW + 5,
      })
      const { issue } = decodeBundle(bundle)
      return { messageId: sent.messageId, issue, spends: [] as ReturnType<typeof decodeBundle>['spends'] }
    },
    async outboxRows() {
      return db.all<Record<string, unknown>>('SELECT * FROM relay_outbox')
    },
    reserved: () => reservedAmount(db),
    async state(): Promise<RemoteState | null> {
      return (await only()).state
    },
    /** A relayer in range stores the blob and sends back `answer`, sealed for the payer. */
    async answer(answer: RelayAnswer) {
      const row = await only()
      rememberSecret(row.blob, row.secret)
      await handOffRow(db, row, [seen({ rssi: -40 })], fakeL2cap({ storeReply: 1, answer }), now())
    },
    async chain(event: Omit<Extract<RemoteEvent, { type: 'chain' }>, 'type' | 'expiry'>) {
      const row = await only()
      await applyEvent(db, row.ref, { type: 'chain', expiry: row.expiresAt - GRACE, ...event }, now())
    },
    async openOutboxAsGateway() {
      return parseInner(await openAsGateway((await only()).blob, 'relay'))
    },
  }
}

export const hex = (byte: string) => Uint8Array.from({ length: 33 }, () => parseInt(byte, 16))
export const WALLET = link.wallet
export const OTHER_WALLET = new Uint8Array(32).fill(8)
export const OTHER_PROGRAM = address(new Uint8Array(32).fill(9))
export const W = link.wallet
export const M = USDC

type Built = { transaction: unknown; meta: unknown }
type FakeTx = {
  signature: string
  confirmationStatus: 'finalized' | 'confirmed'
  err: unknown
  slot: number
  build: () => Promise<Built>
}

const issueFor = (payer: Party, wallet: Uint8Array, amount: bigint): Issue => ({
  issuer: payer.key,
  mint: USDC,
  lockSeq: 1,
  cumEnd: amount,
  salt: new Uint8Array(16).fill(1),
  owner: { type: 'account', address: wallet },
  amount,
  caveats: { expiry: NOW + 3 * 86_400, hopsLeft: 1, flags: 0, scopeKind: ScopeKind.Any, scope: new Uint8Array(20) },
})

const transfer = async (payee: Uint8Array, amount: bigint) => ({
  program: 'spl-token',
  programId: TOKEN_PROGRAM,
  parsed: {
    type: 'transferChecked',
    info: {
      source: 'escrow',
      destination: await associatedTokenAddress(address(payee), address(USDC), TOKEN_PROGRAM),
      mint: address(USDC),
      tokenAmount: { amount: String(amount) },
    },
  },
})

type SettleOptions = {
  credit: bigint
  payer?: Party
  payee?: Uint8Array
  err?: unknown
  confirmationStatus?: 'finalized' | 'confirmed'
  program?: string
  sig?: string
}

const settleInstruction = (o: SettleOptions) => {
  const payer = o.payer ?? party(3)
  const issue = signIssue(payer, issueFor(payer, WALLET, o.credit || 1n))
  const data = getSettleNoteInstructionDataEncoder().encode({ issue: encodeIssueBody(issue.message), spends: [] })
  return { programId: o.program ?? ACTIVE_PROFILE.programId, accounts: [], data: getBase58Decoder().decode(data) }
}

const plainTransfer = async (credit: bigint) => ({
  ...(await transfer(WALLET, credit)),
  accounts: [],
  data: '',
})

const settleInner = async (o: SettleOptions) =>
  o.credit > 0n ? [{ index: 0, instructions: [await transfer(o.payee ?? WALLET, o.credit)] }] : []

/** A transaction that settles a note, crediting `credit` to `payee` (the wallet by default). */
export function settleTx(o: SettleOptions): FakeTx {
  return {
    signature: o.sig ?? 'sig-1',
    confirmationStatus: o.confirmationStatus ?? 'finalized',
    err: o.err ?? null,
    slot: 10,
    build: async () => ({
      transaction: { message: { instructions: [settleInstruction(o)] } },
      meta: { err: o.err ?? null, innerInstructions: await settleInner(o) },
    }),
  }
}

/** A plain token transfer into the wallet's account, with no settlement in it. */
export function transferTx(o: { credit: bigint; sig?: string }): FakeTx {
  return {
    signature: o.sig ?? 'sig-t',
    confirmationStatus: 'finalized',
    err: null,
    slot: 9,
    build: async () => ({
      transaction: { message: { instructions: [await plainTransfer(o.credit)] } },
      meta: { err: null, innerInstructions: [] },
    }),
  }
}

/** A settlement and a token transfer in one transaction: only the settlement's own credit counts. */
export function bundledTx(o: { settle: SettleOptions; transfer: { credit: bigint } }): FakeTx {
  return {
    signature: 'sig-b',
    confirmationStatus: 'finalized',
    err: null,
    slot: 11,
    build: async () => ({
      transaction: { message: { instructions: [settleInstruction(o.settle), await plainTransfer(o.transfer.credit)] } },
      meta: { err: null, innerInstructions: await settleInner(o.settle) },
    }),
  }
}

/** An RPC over a list of transactions, newest first, that remembers the commitments it was asked and the paging bounds. */
export function fakeRpc(txs: FakeTx[]) {
  const asked: string[] = []
  let before: string | undefined
  let until: string | undefined
  const rpc = {
    getAccountInfo: (_target: Address, config: { commitment: string }) => ({
      send: async () => {
        asked.push(config.commitment)
        return { context: { slot: 5n }, value: { owner: TOKEN_PROGRAM, data: ['', 'base64'], lamports: 1n } }
      },
    }),
    getSignaturesForAddress: (_target: Address, config: { commitment: string; before?: string; until?: string }) => ({
      send: async () => {
        asked.push(config.commitment)
        before = config.before
        until = config.until
        const stop = txs.findIndex((tx) => tx.signature === config.until)
        return txs.slice(0, stop < 0 ? txs.length : stop).map((tx) => ({
          signature: tx.signature,
          err: tx.err,
          slot: BigInt(tx.slot),
          blockTime: 1_800_000_000n,
          confirmationStatus: tx.confirmationStatus,
        }))
      },
    }),
    getTransaction: (signature: string, config: { commitment: string }) => ({
      send: async () => {
        asked.push(config.commitment)
        const tx = txs.find((candidate) => candidate.signature === signature)
        return tx ? { slot: BigInt(tx.slot), blockTime: 1_800_000_000n, ...(await tx.build()) } : null
      },
    }),
    commitments: () => asked,
    lastBefore: () => before,
    lastUntil: () => until,
  }
  return rpc as unknown as Rpc<GetAccountInfoApi & GetSignaturesForAddressApi & GetTransactionApi> & {
    commitments(): string[]
    lastBefore(): string | undefined
    lastUntil(): string | undefined
  }
}
