//! Private settlement: a chain settled by the proofs of its messages, with no key or signature of
//! the chain on the wire or on chain. The gateway checks the batch natively before it spends
//! anything, sends it inline or through the proof buffer, and keeps the whole of it under one job.
use crate::{
    float::{Kind, Prefix, Refusal as Limit, Request as FloatRequest},
    jobs::{JobState, SettlementJob},
    limits::{RateLimited, RequestLimits},
    relay::{self, Answer, answer_for},
    server::{Error, Gateway},
    settlements::{
        self, Job, PAID, Planned, Problem, compose_for, ended, finish, float_records, margin,
        read_chain_with, record_address, sponsor_send, token_account_of,
    },
};
use axum::Json;
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use buckspay_client::{
    Program,
    accounts::ZkConfig,
    instructions::{OpenProofBufferBuilder, SettleChainProofBuilder, WriteProofBufferBuilder},
    types::WireMessage,
};
use buckspay_protocol::{
    hash::{domain, purpose},
    window::{self, Settle},
};
use buckspay_zk_verify::{
    ChainContext, MAX_PROOFS, MessagePublic, PROOF_COMPRESSED, consumed_outputs, public_inputs,
    verify_batch_with,
    vk::{self, Vk},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use solana_hash::Hash;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use std::{
    num::NonZeroU32,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

/// The most compute units a private settlement may be given: sixteen spends take 1.25 million.
pub const COMPUTE_UNIT_CEILING: u32 = 1_400_000;
/// The size of a transaction v1.
pub const MAX_TX_BYTES: usize = 4_096;
const SIGNATURE_BYTES: usize = 64;
/// One message on the wire: content, next bit, the state it leaves and its compressed proof.
const WIRE_LEN: usize = 32 + 1 + 32 + PROOF_COMPRESSED;
/// The length of the draw windows the program keeps.
const WINDOW_SECS: i64 = 86_400;
const LAG_ATTEMPTS: u32 = 20;
const LAG_WAIT: Duration = Duration::from_millis(500);
/// How long a proof buffer stays before its payer may close it unsettled, as the program has it.
pub const STALE_BUFFER_SECS: u32 = 3_600;
/// The default of native verifications one network may ask for in a minute.
const VERIFICATIONS_PER_MINUTE: u32 = 6;

mod decimal {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(|_| D::Error::custom("not a decimal amount"))
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tag {
    #[serde(rename = "zk")]
    Zk,
}

/// The request of a private settlement, every byte field in base64.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ZkRequest {
    pub kind: Tag,
    pub vk_sha256: String,
    pub lock_key: String,
    pub lock_seq: u32,
    #[serde(with = "decimal")]
    pub amount: u64,
    #[serde(with = "decimal")]
    pub cum_end: u64,
    #[serde(with = "decimal")]
    pub pay_amount: u64,
    pub expiry: u32,
    pub payee: String,
    pub messages: Vec<MessageJson>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageJson {
    pub content: String,
    pub next_bit: u8,
    pub s_out: String,
    pub proof: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Wire {
    pub content: [u8; 32],
    pub next_bit: u8,
    pub s_out: [u8; 32],
    pub proof: [u8; PROOF_COMPRESSED],
}

/// A request read: every field at its length.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Parsed {
    pub vk_sha256: [u8; 32],
    pub issuer_key: [u8; 33],
    pub lock_seq: u32,
    pub amount: u64,
    pub cum_end: u64,
    pub pay_amount: u64,
    pub expiry: u32,
    pub payee: [u8; 32],
    pub messages: Vec<Wire>,
}

fn bytes<const N: usize>(value: &str, what: &'static str) -> Result<[u8; N], Problem> {
    B64.decode(value)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(Problem::Invalid(what))
}

impl ZkRequest {
    pub fn parse(&self) -> Result<Parsed, Problem> {
        if !(2..=MAX_PROOFS).contains(&self.messages.len()) {
            return Err(Problem::Invalid("a chain has an issue and 1 to 16 spends"));
        }
        let messages = self
            .messages
            .iter()
            .map(|m| {
                if m.next_bit > 1 {
                    return Err(Problem::Invalid("a next bit is 0 or 1"));
                }
                Ok(Wire {
                    content: bytes(&m.content, "content is not 32 bytes of base64")?,
                    next_bit: m.next_bit,
                    s_out: bytes(&m.s_out, "sOut is not 32 bytes of base64")?,
                    proof: bytes(&m.proof, "proof is not 192 bytes of base64")?,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Parsed {
            vk_sha256: bytes(&self.vk_sha256, "vkSha256 is not 32 bytes of base64")?,
            issuer_key: bytes(&self.lock_key, "lockKey is not 33 bytes of base64")?,
            lock_seq: self.lock_seq,
            amount: self.amount,
            cum_end: self.cum_end,
            pay_amount: self.pay_amount,
            expiry: self.expiry,
            payee: bytes(&self.payee, "payee is not 32 bytes of base64")?,
            messages,
        })
    }
}

/// Why a request does not go on, before the chain is asked.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    RateLimited,
    StaleKey,
    Invalid,
}

impl From<Refusal> for Problem {
    fn from(refusal: Refusal) -> Self {
        match refusal {
            Refusal::RateLimited => Problem::Limits(Limit::PrefixBusy, None),
            Refusal::StaleKey => Problem::StaleKey,
            Refusal::Invalid => Problem::Invalid("the proofs do not verify"),
        }
    }
}

/// What the settlement names, which is what the proofs bind: every public input follows from it
/// and the wire messages, none from a proof.
fn digest(request: &Parsed) -> [u8; 16] {
    let mut hash = Sha256::new();
    hash.update(b"zk");
    hash.update(request.issuer_key);
    hash.update(request.lock_seq.to_le_bytes());
    hash.update(request.amount.to_le_bytes());
    hash.update(request.cum_end.to_le_bytes());
    hash.update(request.pay_amount.to_le_bytes());
    hash.update(request.expiry.to_le_bytes());
    hash.update(request.payee);
    for message in &request.messages {
        hash.update(message.content);
        hash.update([message.next_bit]);
        hash.update(message.s_out);
    }
    hash.finalize()[..16].try_into().unwrap()
}

/// The key of a private settlement job. Groth16 proofs can be re-randomised by anyone, so the
/// key is derived from the public values only: the same chain is the same job whatever its proofs.
pub fn job_key(request: &Parsed) -> String {
    hex::encode(digest(request))
}

fn nonce_of(request: &Parsed) -> u64 {
    u64::from_le_bytes(digest(request)[..8].try_into().unwrap())
}

pub fn context(request: &Parsed, domain: [u8; 32], mint: [u8; 32]) -> ChainContext {
    ChainContext {
        domain,
        issuer_key: request.issuer_key,
        mint,
        lock_seq: request.lock_seq,
        amount: request.amount,
        cum_end: request.cum_end,
        payee: request.payee,
        pay_amount: request.pay_amount,
        expiry: request.expiry,
    }
}

fn public_of(request: &Parsed) -> Vec<MessagePublic> {
    request
        .messages
        .iter()
        .map(|m| MessagePublic {
            content: m.content,
            next_bit: m.next_bit,
            s_out: m.s_out,
        })
        .collect()
}

/// Verifies the whole batch with the host implementation of the program's verifier.
pub fn verify(request: &Parsed, ctx: &ChainContext, key: &Vk) -> Result<(), Refusal> {
    let publics = public_inputs(ctx, &public_of(request)).map_err(|_| Refusal::Invalid)?;
    let proofs: Vec<[u8; PROOF_COMPRESSED]> = request.messages.iter().map(|m| m.proof).collect();
    verify_batch_with(key, &proofs, &publics).map_err(|_| Refusal::Invalid)
}

/// The key hashes the program holds, and for how long its previous key still settles.
#[derive(Clone, Copy, Debug)]
pub struct Trusted {
    pub current: [u8; 32],
    pub previous: [u8; 32],
    pub rotated_at: i64,
    /// The longest life of a note plus the grace after its expiry.
    pub window: u32,
}

/// The key a batch is verified under: the one this build carries when the program still holds
/// it, or the previous one while the notes made under it can settle.
pub fn select(vk_sha256: &[u8; 32], trusted: &Trusted, now: u32) -> Result<Vk<'static>, Refusal> {
    if vk_sha256 == vk::VK.sha256 {
        return if trusted.current == *vk_sha256 {
            Ok(vk::VK)
        } else {
            Err(Refusal::StaleKey)
        };
    }
    let until = trusted.rotated_at.saturating_add(i64::from(trusted.window));
    match vk::PREVIOUS.filter(|key| key.sha256 == vk_sha256 && trusted.previous == *vk_sha256) {
        Some(key) if trusted.rotated_at != 0 && i64::from(now) <= until => Ok(key),
        _ => Err(Refusal::StaleKey),
    }
}

/// What the gateway bounds about private settlement: how many native verifications a network may
/// ask for, where the key files are published and what it has verified.
pub struct Zk {
    limits: RequestLimits,
    verified: AtomicU64,
    keys_url: Option<String>,
}

impl Default for Zk {
    fn default() -> Self {
        Self::new(NonZeroU32::new(VERIFICATIONS_PER_MINUTE).unwrap())
    }
}

impl Zk {
    pub fn new(per_minute: NonZeroU32) -> Self {
        Self {
            limits: RequestLimits::new(per_minute),
            verified: AtomicU64::new(0),
            keys_url: None,
        }
    }

    /// Where `/zk/<vkSha256>/` is served from.
    pub fn with_keys_url(mut self, url: String) -> Self {
        self.keys_url = Some(url.trim_end_matches('/').to_owned());
        self
    }

    /// Counts a verification against the network's bucket, then verifies: the bucket is asked
    /// before any pairing is computed.
    pub fn admit(
        &self,
        prefix: Prefix,
        request: &Parsed,
        ctx: &ChainContext,
        key: &Vk,
    ) -> Result<(), Refusal> {
        self.limits
            .check(prefix)
            .map_err(|RateLimited| Refusal::RateLimited)?;
        self.verified.fetch_add(1, Ordering::Relaxed);
        verify(request, ctx, key)
    }

    pub fn verifications(&self) -> u64 {
        self.verified.load(Ordering::Relaxed)
    }
}

/// A rolling draw window as the program keeps it: the current bucket and the one before.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Window {
    pub start: i64,
    pub cur: u64,
    pub prev: u64,
}

impl Window {
    /// Whether `amount` is admitted, and if not, in how many seconds the window rolls.
    pub fn check(&self, now: i64, amount: u64, cap: u64, len: i64) -> Result<(), u32> {
        self.rolled(now, len).admitted(amount, cap, len)
    }

    /// Admits `amount` as the program does.
    pub fn admit(&mut self, now: i64, amount: u64, cap: u64, len: i64) -> Result<(), u32> {
        let mut rolled = self.rolled(now, len);
        rolled.admitted(amount, cap, len)?;
        rolled.window.cur += amount;
        *self = rolled.window;
        Ok(())
    }

    fn rolled(&self, now: i64, len: i64) -> Rolled {
        let mut window = *self;
        let mut elapsed = now.saturating_sub(window.start).max(0);
        if elapsed >= 2 * len {
            window = Window {
                start: now,
                ..Window::default()
            };
            elapsed = 0;
        } else if elapsed >= len {
            window.prev = window.cur;
            window.cur = 0;
            window.start += len;
            elapsed -= len;
        }
        Rolled { window, elapsed }
    }
}

struct Rolled {
    window: Window,
    elapsed: i64,
}

impl Rolled {
    fn admitted(&self, amount: u64, cap: u64, len: i64) -> Result<(), u32> {
        let carried = u128::from(self.window.prev)
            * u128::try_from(len - self.elapsed).unwrap_or(0)
            / u128::try_from(len).unwrap_or(1);
        let total = u128::from(self.window.cur) + carried + u128::from(amount);
        if total <= u128::from(cap) {
            return Ok(());
        }
        Err(u32::try_from(len - self.elapsed).unwrap_or(60).max(1))
    }
}

pub fn account_discriminator(name: &str) -> [u8; 8] {
    Sha256::digest(format!("account:{name}").as_bytes())[..8]
        .try_into()
        .unwrap()
}

/// The per-mint policy and draws the program keeps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZkMint {
    pub global_cap: u64,
    pub lock_cap: u64,
    pub record_fee: u64,
    pub fee_account: Pubkey,
    pub window: Window,
}

fn le<const N: usize>(data: &[u8], at: usize) -> [u8; N] {
    data[at..at + N].try_into().unwrap()
}

fn window_at(data: &[u8], at: usize) -> Window {
    Window {
        start: i64::from_le_bytes(le(data, at)),
        cur: u64::from_le_bytes(le(data, at + 8)),
        prev: u64::from_le_bytes(le(data, at + 16)),
    }
}

impl ZkMint {
    pub const LEN: usize = 8 + 3 * 8 + 32 + 24 + 1;

    pub fn from_bytes(data: &[u8]) -> Option<Self> {
        (data.len() == Self::LEN && data[..8] == account_discriminator("ZkMint")).then(|| Self {
            global_cap: u64::from_le_bytes(le(data, 8)),
            lock_cap: u64::from_le_bytes(le(data, 16)),
            record_fee: u64::from_le_bytes(le(data, 24)),
            fee_account: Pubkey::new_from_array(le(data, 32)),
            window: window_at(data, 64),
        })
    }
}

/// The draws of a lock: its window.
fn draws_from(data: &[u8]) -> Option<Window> {
    (data.len() == 8 + 24 + 1 && data[..8] == account_discriminator("ZkLockDraws"))
        .then(|| window_at(data, 8))
}

/// What the program holds of a buffer: its length and how much of it is written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct BufferView {
    len: u32,
    written: u32,
}

impl BufferView {
    fn from_bytes(data: &[u8]) -> Option<Self> {
        (data.len() >= 56 && data[..8] == account_discriminator("ProofBuffer")).then(|| Self {
            len: u32::from_le_bytes(le(data, 48)),
            written: u32::from_le_bytes(le(data, 52)),
        })
    }
}

pub fn config_address(program: &Program) -> Pubkey {
    Pubkey::find_program_address(&[b"zk-config"], &program.id()).0
}

pub fn mint_address(program: &Program, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"zk-mint", mint.as_ref()], &program.id()).0
}

fn draws_address(program: &Program, lock: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"zk-draws", lock.as_ref()], &program.id()).0
}

fn buffer_address(program: &Program, payer: &Pubkey, nonce: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[b"proof-buffer", payer.as_ref(), &nonce.to_le_bytes()],
        &program.id(),
    )
    .0
}

/// The accounts a settlement names.
#[derive(Clone, Debug)]
pub struct Accounts {
    pub program: Program,
    pub payer: Pubkey,
    pub lock: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub destination: Pubkey,
    pub fee_account: Pubkey,
    /// The record of every output the chain consumes, in chain order.
    pub records: Vec<Pubkey>,
}

/// How a settlement is sent: in one transaction, or its messages written to a buffer first.
#[derive(Clone, Debug)]
pub enum Plan {
    Inline(Vec<Instruction>),
    Buffer {
        nonce: u64,
        open: Instruction,
        writes: Vec<Instruction>,
        settle: Instruction,
    },
}

fn wire_message(message: &Wire) -> WireMessage {
    WireMessage {
        content: message.content,
        next_bit: message.next_bit,
        s_out: message.s_out,
        proof: message.proof,
    }
}

fn settle_instruction(a: &Accounts, request: &Parsed, buffer: Option<Pubkey>) -> Instruction {
    let mut builder = SettleChainProofBuilder::new();
    builder
        .payer(a.payer)
        .config(config_address(&a.program))
        .zk_mint(mint_address(&a.program, &a.mint))
        .lock(a.lock)
        .ledger(a.program.find_ledger_pda(&a.lock).0)
        .escrow(a.program.find_escrow_pda(&a.lock).0)
        .mint(a.mint)
        .destination(a.destination)
        .fee_account(a.fee_account)
        .draws(draws_address(&a.program, &a.lock))
        .buffer(buffer)
        .token_program(a.token_program)
        .vk_sha256(request.vk_sha256)
        .issuer_key(request.issuer_key)
        .lock_seq(request.lock_seq)
        .amount(request.amount)
        .cum_end(request.cum_end)
        .pay_amount(request.pay_amount)
        .expiry(request.expiry)
        .messages(if buffer.is_some() {
            Vec::new()
        } else {
            request.messages.iter().map(wire_message).collect()
        })
        .add_remaining_accounts(
            &a.records
                .iter()
                .map(|record| AccountMeta::new(*record, false))
                .collect::<Vec<_>>(),
        );
    a.program.target(builder.instruction())
}

fn wire_bytes(request: &Parsed) -> Vec<u8> {
    let mut out = Vec::with_capacity(request.messages.len() * WIRE_LEN);
    for m in &request.messages {
        out.extend_from_slice(&m.content);
        out.push(m.next_bit);
        out.extend_from_slice(&m.s_out);
        out.extend_from_slice(&m.proof);
    }
    out
}

/// The size of a transaction of `instructions`, signed by the fee payer, which is the first
/// account of each of them.
pub fn len_of(instructions: &[Instruction]) -> usize {
    let payer = instructions[0].accounts[0].pubkey;
    compose_for(
        &payer,
        instructions,
        Hash::default(),
        COMPUTE_UNIT_CEILING,
        u32::MAX,
        u64::MAX,
    )
    .map_or(usize::MAX, |message| {
        message.serialize().len() + SIGNATURE_BYTES
    })
}

pub fn inline_len(a: &Accounts, request: &Parsed) -> usize {
    len_of(&[settle_instruction(a, request, None)])
}

fn open_instruction(a: &Accounts, nonce: u64, len: usize) -> Instruction {
    let mut builder = OpenProofBufferBuilder::new();
    builder
        .payer(a.payer)
        .buffer(buffer_address(&a.program, &a.payer, nonce))
        .nonce(nonce)
        .len(u32::try_from(len).unwrap_or(u32::MAX));
    a.program.target(builder.instruction())
}

fn write_instruction(a: &Accounts, nonce: u64, offset: usize, data: &[u8]) -> Instruction {
    let mut builder = WriteProofBufferBuilder::new();
    builder
        .payer(a.payer)
        .buffer(buffer_address(&a.program, &a.payer, nonce))
        .offset(u32::try_from(offset).unwrap_or(u32::MAX))
        .data(data.to_vec());
    a.program.target(builder.instruction())
}

/// The writes of `data` from `from` on, each as long as its transaction allows; the first shares
/// its transaction with the opening of the buffer when `with_open`.
fn writes(a: &Accounts, nonce: u64, data: &[u8], from: usize, with_open: bool) -> Vec<Instruction> {
    let open = open_instruction(a, nonce, data.len());
    let room = |first: bool| {
        let empty = write_instruction(a, nonce, 0, &[]);
        let used = if first && with_open {
            len_of(&[open.clone(), empty])
        } else {
            len_of(&[empty])
        };
        MAX_TX_BYTES - used
    };
    let (mut out, mut at) = (Vec::new(), from);
    while at < data.len() {
        let end = (at + room(out.is_empty())).min(data.len());
        out.push(write_instruction(a, nonce, at, &data[at..end]));
        at = end;
    }
    out
}

/// Inline when the settlement built as one transaction fits the size limit, else through a buffer.
pub fn route(a: &Accounts, request: &Parsed) -> Plan {
    let inline = settle_instruction(a, request, None);
    if len_of(std::slice::from_ref(&inline)) <= MAX_TX_BYTES {
        return Plan::Inline(vec![inline]);
    }
    let nonce = nonce_of(request);
    let data = wire_bytes(request);
    Plan::Buffer {
        nonce,
        open: open_instruction(a, nonce, data.len()),
        writes: writes(a, nonce, &data, 0, true),
        settle: settle_instruction(
            a,
            request,
            Some(buffer_address(&a.program, &a.payer, nonce)),
        ),
    }
}

/// Selects the key, verifies the batch and chooses the route.
pub fn plan(
    request: &Parsed,
    ctx: &ChainContext,
    trusted: &Trusted,
    now: u32,
    a: &Accounts,
) -> Result<Plan, Refusal> {
    let key = select(&request.vk_sha256, trusted, now)?;
    verify(request, ctx, &key)?;
    Ok(route(a, request))
}

/// The transaction to send next, from what the chain holds of the buffer.
fn next(
    a: &Accounts,
    request: &Parsed,
    plan: Plan,
    buffer: Option<BufferView>,
) -> Result<Step, Error> {
    let Plan::Buffer {
        nonce,
        open,
        writes: first,
        settle,
    } = plan
    else {
        let Plan::Inline(instructions) = plan else {
            unreachable!("not a buffer");
        };
        return Ok(Step {
            instructions,
            settles: true,
            left: 1,
            batch: (0, 0),
        });
    };
    let data = wire_bytes(request);
    Ok(match buffer {
        None => {
            let mut instructions = vec![open];
            instructions.push(first[0].clone());
            Step {
                instructions,
                settles: false,
                left: first.len() + 1,
                batch: (1, 0),
            }
        }
        Some(view) if view.len as usize != data.len() => return Err(Error::Upstream),
        Some(view) if view.written < view.len => {
            let rest = writes(a, nonce, &data, view.written as usize, false);
            Step {
                instructions: vec![rest[0].clone()],
                settles: false,
                left: rest.len() + 1,
                batch: (2, view.written as usize),
            }
        }
        Some(_) => Step {
            instructions: vec![settle],
            settles: true,
            left: 1,
            batch: (3, 0),
        },
    })
}

struct Step {
    instructions: Vec<Instruction>,
    /// Whether this transaction is the settlement itself, which pays and records.
    settles: bool,
    left: usize,
    batch: (usize, usize),
}

/// Checks a private settlement against the chain as far as it can be asked, without spending
/// anything, and plans the next transaction. The batch is verified when `verify_now`: once, at
/// admission; a job that is resumed was verified then.
pub(crate) async fn inspect(
    state: &Gateway,
    prefix: Prefix,
    request: &Parsed,
    verify_now: bool,
) -> Result<Planned, Error> {
    let program = state.settings.program;
    let ctx = context(
        request,
        domain(
            purpose::NOTE,
            &state.settings.genesis_hash,
            &program.id().to_bytes(),
        ),
        state.settings.mint.to_bytes(),
    );
    let outputs = consumed_outputs(&ctx, &public_of(request))
        .map_err(|_| Problem::Invalid("the messages are not a valid chain"))?;
    let records = outputs
        .iter()
        .map(|output| record_address(&program.id(), output))
        .collect::<Result<Vec<_>, _>>()?;
    let lock_address = program
        .find_lock_pda(&request.issuer_key, request.lock_seq)
        .0;
    let payer = state.fee_payer.pubkey();
    let extra = [
        config_address(&program),
        mint_address(&program, &state.settings.mint),
        draws_address(&program, &lock_address),
        buffer_address(&program, &payer, nonce_of(request)),
    ];
    let (reads, extra) = read_chain_with(
        state,
        &request.issuer_key,
        request.lock_seq,
        &records,
        &extra,
    )
    .await?;
    let owned = |account: &Option<solana_account::Account>| {
        account
            .as_ref()
            .filter(|account| account.owner == program.id())
            .map(|account| account.data.clone())
    };
    let config = owned(&extra[0])
        .and_then(|data| ZkConfig::from_bytes(&data).ok())
        .ok_or(Problem::Paused)?;
    if config.paused {
        return Err(Problem::Paused.into());
    }
    let windows = state.settings.windows;
    let trusted = Trusted {
        current: config.current.vk,
        previous: config.previous.vk,
        rotated_at: config.rotated_at,
        window: windows.ticket_ttl_max.saturating_add(windows.grace),
    };
    let key = select(&request.vk_sha256, &trusted, reads.now).map_err(Problem::from)?;
    if reads.lock.mint != state.settings.mint || request.cum_end > reads.lock.backing {
        return Err(Problem::Lock("wrong_lock").into());
    }
    if reads.ledger.backing_left < request.pay_amount {
        return Err(Problem::Lock("insufficient_backing").into());
    }
    let mint = owned(&extra[1])
        .and_then(|data| ZkMint::from_bytes(&data))
        .ok_or(Problem::Paused)?;

    for (record, message) in reads.records.iter().zip(&request.messages[1..]) {
        if let Some(record) = record
            && record.content != message.content
        {
            return Err(Problem::Conflict(record.content).into());
        }
    }
    if let Some(Some(record)) = reads.records.last()
        && record.flags & PAID != 0
    {
        return Ok(Planned::Settled);
    }
    let latest = reads
        .now
        .checked_add(margin(&windows))
        .ok_or(Problem::Window("window"))?;
    match window::settle_in(&windows, request.expiry, reads.lock.lock_until, latest) {
        Settle::Open => {}
        Settle::LockEnded => return Err(Problem::Window("lock_ended").into()),
        Settle::Closed => return Err(Problem::Window("window").into()),
    }

    let created = reads.records.iter().filter(|r| r.is_none()).count();
    if request.pay_amount <= mint.record_fee.saturating_mul(created as u64) {
        return Err(Problem::BelowFee.into());
    }
    let now = i64::from(reads.now);
    let draws = owned(&extra[2])
        .and_then(|data| draws_from(&data))
        .unwrap_or_default();
    mint.window
        .check(now, request.pay_amount, mint.global_cap, WINDOW_SECS)
        .map_err(Problem::CapExhausted)?;
    draws
        .check(now, request.pay_amount, mint.lock_cap, WINDOW_SECS)
        .map_err(Problem::CapExhausted)?;

    let destination = token_account_of(
        state,
        &Pubkey::new_from_array(request.payee),
        &reads.token_program,
    )
    .await?;
    if verify_now {
        state
            .zk
            .admit(prefix, request, &ctx, &key)
            .map_err(Problem::from)?;
    }

    let accounts = Accounts {
        program,
        payer,
        lock: lock_address,
        mint: state.settings.mint,
        token_program: reads.token_program,
        destination,
        fee_account: mint.fee_account,
        records: records.clone(),
    };
    let buffer = extra[3]
        .as_ref()
        .filter(|account| account.owner == program.id())
        .and_then(|account| BufferView::from_bytes(&account.data));
    let step = next(&accounts, request, route(&accounts, request), buffer)?;

    let wanted: Vec<(Pubkey, u32)> = records
        .iter()
        .map(|record| (*record, reads.lock.lock_until))
        .collect();
    let new = float_records(
        &program.id(),
        &windows,
        reads.lock.lock_until,
        &wanted,
        &reads.records,
    );
    let mut holder = [0u8; 33];
    holder[1..].copy_from_slice(&request.payee);
    let deadline =
        window::settle_deadline_in(&windows, request.expiry).min(u64::from(reads.lock.lock_until));
    Ok(Planned::Send(Box::new(Job {
        kind: Kind::Settlement,
        instructions: step.instructions,
        verified: 0,
        request: FloatRequest {
            kind: Kind::Settlement,
            prefix,
            key: holder,
            issuer: request.issuer_key,
            lock: lock_address.to_bytes(),
            bond: reads.lock.bond,
            amount: request.pay_amount,
            records: if step.settles { new } else { Vec::new() },
            rent: state.rents().record,
            now: reads.now,
        },
        lock: lock_address,
        remaining: step.left,
        priced: created as u32,
        batch: step.batch,
        deadline: u32::try_from(deadline).unwrap_or(u32::MAX),
        tracked: None,
        ceiling: COMPUTE_UNIT_CEILING,
    })))
}

/// Admits a private settlement: checks it and everything it meets, writes its job down and
/// answers `submitted` only then. The job is sent in the background and finished by the janitor
/// if this process does not.
pub(crate) async fn submit(
    state: &Arc<Gateway>,
    prefix: Prefix,
    request: ZkRequest,
) -> Result<Json<serde_json::Value>, Error> {
    let parsed = request.parse()?;
    let key = job_key(&parsed);
    if state.jobs.get(&key).is_some() {
        return Ok(Json(Answer::Duplicate.body()));
    }
    let job = match inspect(state, prefix, &parsed, true).await {
        Ok(Planned::Send(job)) => *job,
        other => return Ok(Json(answer_for(&other).body())),
    };
    let now = job.request.now;
    if let Err(refusal) = state
        .settlements
        .reserve_priced(job.request.clone(), job.priced)
    {
        let refused = Err(settlements::limits(state, refusal, now));
        return Ok(Json(answer_for(&refused).body()));
    }
    let row = SettlementJob {
        key,
        issue: String::new(),
        spends: Vec::new(),
        prefix,
        created_at: now,
        deadline: job.deadline,
        batches_done: 0,
        state: JobState::Pending,
        last_signature: None,
        last_valid_block_height: None,
        not_before: None,
        zk: Some(request),
    };
    let answer = match state.jobs.begin(row.clone()) {
        Ok(true) => {
            relay::drive_later(Arc::clone(state), row);
            Answer::Submitted
        }
        Ok(false) => Answer::Duplicate,
        Err(_) => answer_for(&Err(Error::Upstream)),
    };
    Ok(Json(answer.body()))
}

/// Sends what a job still has to send, one transaction after the other, each planned from what
/// the chain says when it is sent.
pub(crate) async fn drive(
    state: &Gateway,
    prefix: Prefix,
    request: &Parsed,
    key: &str,
) -> Result<serde_json::Value, Error> {
    let Some(_driving) = state.jobs.drive(key) else {
        return Err(Error::Busy);
    };
    let (mut previous, mut lag) = (None, 0);
    loop {
        let job = match inspect(state, prefix, request, false).await {
            Ok(Planned::Settled) => {
                finish(state.jobs.end(key, JobState::Done));
                return Ok(json!({ "status": "settled" }));
            }
            Ok(Planned::Send(job)) => *job,
            Err(error) => {
                if let Some(ended) = ended(&error) {
                    finish(state.jobs.end(key, ended));
                }
                return Err(error);
            }
        };
        if previous == Some(job.batch) {
            lag += 1;
            if lag > LAG_ATTEMPTS {
                return Err(Error::Upstream);
            }
            tokio::time::sleep(LAG_WAIT).await;
            continue;
        }
        lag = 0;
        let (batch, last) = (job.batch, job.remaining == 1);
        let signature = sponsor_send(
            state,
            Job {
                tracked: Some(key.to_owned()),
                ..job
            },
        )
        .await?;
        if last {
            finish(state.jobs.end(key, JobState::Done));
            return Ok(json!({ "signature": signature.to_string() }));
        }
        finish(state.jobs.landed(key));
        previous = Some(batch);
    }
}

/// Continues a job the gateway started and did not finish.
pub(crate) async fn resume(
    state: &Gateway,
    job: &SettlementJob,
    request: &ZkRequest,
) -> Result<serde_json::Value, Error> {
    drive(state, job.prefix, &request.parse()?, &job.key).await
}

/// What the program holds of the keys the app trusts, and where their files are published.
pub(crate) async fn config(
    axum::extract::State(state): axum::extract::State<Arc<Gateway>>,
) -> Result<Json<serde_json::Value>, Error> {
    let program = state.settings.program;
    let account = crate::onboard::read(&state, &[config_address(&program)])
        .await?
        .remove(0)
        .filter(|account| account.owner == program.id())
        .ok_or(Error::Settlement(Problem::Paused))?;
    let config = ZkConfig::from_bytes(&account.data).map_err(|_| Error::Upstream)?;
    let base = state
        .zk
        .keys_url
        .as_deref()
        .ok_or(Error::BadRequest("the key files are not published here"))?;
    Ok(Json(config_body(
        &config,
        base,
        state.settings.windows.ticket_ttl_max + state.settings.windows.grace,
    )))
}

/// The keys the program holds, copied as they are: the app checks their hashes against the chain
/// or its own pin, never this answer alone. The previous key is listed until it stops settling.
fn config_body(config: &ZkConfig, base: &str, life: u32) -> serde_json::Value {
    let keys = |hashes: &buckspay_client::types::KeyHashes| {
        let vk = hex::encode(hashes.vk);
        json!({
            "vkSha256": vk,
            "pkUrl": format!("{base}/zk/{vk}/pk.bin"),
            "pkSha256": hex::encode(hashes.pk),
            "dumpSha256": hex::encode(hashes.dump),
            "ccsUrl": format!("{base}/zk/{vk}/ccs.bin"),
            "ccsSha256": hex::encode(hashes.ccs),
        })
    };
    let mut body = json!({ "current": keys(&config.current) });
    if config.rotated_at != 0 {
        let mut previous = keys(&config.previous);
        previous["validUntil"] = json!(config.rotated_at.saturating_add(i64::from(life)));
        body["previous"] = previous;
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;
    use buckspay_protocol::{
        cluster::DEVNET_GENESIS_HASH,
        hash::{domain, purpose},
        profile::SHORT_PROGRAM_ID,
    };
    use buckspay_zk_verify::vk;
    use proptest::prelude::*;
    use solana_keypair::Keypair;
    use solana_signer::Signer;
    use std::{num::NonZeroU32, str::FromStr};

    const CLIENT: Prefix = Prefix::V4([203, 0, 113]);
    const NOW: u32 = 1_800_000_000;

    fn fixture_request(name: &str) -> Parsed {
        let file: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/zk_requests.json")).unwrap();
        serde_json::from_value::<ZkRequest>(file["requests"][name].clone())
            .unwrap()
            .parse()
            .unwrap()
    }

    /// A request with `spends` spends whose proofs are zeros: only its size is meaningful.
    fn sized(spends: usize) -> Parsed {
        let mut request = fixture_request("n3");
        request.messages = vec![
            Wire {
                content: [1; 32],
                next_bit: 0,
                s_out: [2; 32],
                proof: [3; 192],
            };
            spends + 1
        ];
        request
    }

    fn mint() -> Pubkey {
        Keypair::new_from_array([0x4d; 32]).pubkey()
    }

    fn context_of(request: &Parsed) -> ChainContext {
        let program = Pubkey::from_str(SHORT_PROGRAM_ID).unwrap();
        context(
            request,
            domain(purpose::NOTE, &DEVNET_GENESIS_HASH, &program.to_bytes()),
            mint().to_bytes(),
        )
    }

    fn trusted() -> Trusted {
        Trusted {
            current: *vk::VK.sha256,
            previous: [0; 32],
            rotated_at: 0,
            window: 72 * 3_600,
        }
    }

    fn accounts() -> Accounts {
        let key = |n: u8| Keypair::new_from_array([n; 32]).pubkey();
        Accounts {
            program: Program::new(Pubkey::from_str(SHORT_PROGRAM_ID).unwrap()),
            payer: key(1),
            lock: key(2),
            mint: mint(),
            token_program: key(3),
            destination: key(4),
            fee_account: key(5),
            records: (0..16).map(|n| key(10 + n)).collect(),
        }
    }

    fn plan_of(request: &Parsed) -> Result<Plan, Refusal> {
        plan(request, &context_of(request), &trusted(), NOW, &accounts())
    }

    #[test]
    fn refuses_a_stale_key_without_planning() {
        let mut stale = fixture_request("n3");
        stale.vk_sha256[0] ^= 1;
        assert!(matches!(plan_of(&stale), Err(Refusal::StaleKey)));
    }

    #[test]
    fn refuses_an_invalid_batch_without_planning() {
        let mut bad = fixture_request("n3");
        bad.messages[1].proof[10] ^= 1;
        assert!(matches!(plan_of(&bad), Err(Refusal::Invalid)));
    }

    #[test]
    fn plans_inline_up_to_the_cap_and_buffer_above() {
        assert!(matches!(
            plan_of(&fixture_request("n3")).unwrap(),
            Plan::Inline(_)
        ));
        assert!(matches!(
            plan_of(&fixture_request("n16")).unwrap(),
            Plan::Buffer { writes, .. } if writes.len() == 2
        ));
    }

    #[test]
    fn job_key_is_the_same_for_the_same_settlement() {
        let a = fixture_request("n3");
        assert_eq!(job_key(&a), job_key(&a.clone()));
        assert_ne!(job_key(&a), job_key(&fixture_request("n16")));
    }

    #[test]
    fn job_key_ignores_proof_bytes() {
        let (a, reproved) = (fixture_request("n3"), fixture_request("n3b"));
        assert_ne!(a.messages[0].proof, reproved.messages[0].proof);
        assert_eq!(job_key(&a), job_key(&reproved));
        let mut other = a.clone();
        other.messages[2].content[0] ^= 1;
        assert_ne!(job_key(&a), job_key(&other));
    }

    #[test]
    fn rate_limit_is_checked_before_native_verification() {
        let zk = Zk::new(NonZeroU32::new(1).unwrap());
        let request = fixture_request("n3");
        let (ctx, key) = (context_of(&request), &vk::VK);
        zk.admit(CLIENT, &request, &ctx, key).unwrap();
        assert!(matches!(
            zk.admit(CLIENT, &request, &ctx, key),
            Err(Refusal::RateLimited)
        ));
        assert_eq!(zk.verifications(), 1);
        zk.admit(Prefix::V4([198, 51, 100]), &request, &ctx, key)
            .unwrap();
        assert_eq!(zk.verifications(), 2);
    }

    #[test]
    fn inline_choice_comes_from_the_built_transaction_size() {
        for n in 1..=16 {
            let request = sized(n);
            let ctx = accounts();
            let inline = inline_len(&ctx, &request);
            match route(&ctx, &request) {
                Plan::Inline(_) => assert!(inline <= MAX_TX_BYTES, "n={n}"),
                Plan::Buffer { .. } => assert!(inline > MAX_TX_BYTES, "n={n}"),
            }
        }
    }

    #[test]
    fn every_transaction_of_the_buffer_route_fits() {
        let ctx = accounts();
        let Plan::Buffer {
            open,
            writes,
            settle,
            ..
        } = route(&ctx, &sized(16))
        else {
            panic!("sixteen spends do not fit one transaction");
        };
        let first = [open, writes[0].clone()];
        assert!(len_of(&first) <= MAX_TX_BYTES);
        for write in &writes[1..] {
            assert!(len_of(std::slice::from_ref(write)) <= MAX_TX_BYTES);
        }
        assert!(len_of(&[settle]) <= MAX_TX_BYTES);
    }

    #[test]
    fn the_previous_key_is_accepted_only_until_rotation_plus_note_life_and_grace() {
        let previous = vk::PREVIOUS.expect("test keys");
        let rotated = Trusted {
            current: [9; 32],
            previous: *previous.sha256,
            rotated_at: i64::from(NOW),
            window: 1_000,
        };
        assert!(select(previous.sha256, &rotated, NOW + 1_000).is_ok());
        assert_eq!(
            select(previous.sha256, &rotated, NOW + 1_001).err(),
            Some(Refusal::StaleKey)
        );
        let revoked = Trusted {
            rotated_at: 0,
            ..rotated
        };
        assert_eq!(
            select(previous.sha256, &revoked, NOW).err(),
            Some(Refusal::StaleKey)
        );
        assert_eq!(
            select(vk::VK.sha256, &rotated, NOW).err(),
            Some(Refusal::StaleKey)
        );
    }

    #[test]
    fn what_the_program_holds_of_the_keys_is_served_with_the_previous_one_until_it_expires() {
        use buckspay_client::types::KeyHashes;
        let hashes = |n: u8| KeyHashes {
            vk: [n; 32],
            pk: [n + 1; 32],
            dump: [n + 2; 32],
            ccs: [n + 3; 32],
        };
        let mut config = ZkConfig {
            discriminator: [0; 8],
            admin: Pubkey::default(),
            pauser: Pubkey::default(),
            paused: false,
            current: hashes(10),
            previous: hashes(20),
            rotated_at: 0,
            bump: 0,
        };
        let body = config_body(&config, "https://keys.example", 1_000);
        assert_eq!(body["current"]["vkSha256"], hex::encode([10; 32]));
        assert_eq!(
            body["current"]["pkUrl"],
            format!("https://keys.example/zk/{}/pk.bin", hex::encode([10; 32]))
        );
        assert_eq!(body["current"]["ccsSha256"], hex::encode([13; 32]));
        assert!(
            body.get("previous").is_none(),
            "no rotation, no previous key"
        );
        config.rotated_at = 5_000;
        let body = config_body(&config, "https://keys.example", 1_000);
        assert_eq!(body["previous"]["vkSha256"], hex::encode([20; 32]));
        assert_eq!(body["previous"]["validUntil"], 6_000);
    }

    #[test]
    fn a_pause_or_a_cap_never_ends_a_job_and_a_stale_key_or_a_fee_does() {
        let ended_by = |problem| ended(&Error::Settlement(problem));
        assert_eq!(ended_by(Problem::Paused), None);
        assert_eq!(ended_by(Problem::CapExhausted(30)), None);
        assert_eq!(ended_by(Problem::Limits(Limit::PrefixBusy, None)), None);
        assert_eq!(ended_by(Problem::StaleKey), Some(JobState::Refused));
        assert_eq!(ended_by(Problem::BelowFee), Some(JobState::Refused));
    }

    #[test]
    fn the_payer_is_told_what_is_final_and_when_to_come_back_for_the_rest() {
        let answer = |problem| answer_for(&Err(Error::Settlement(problem)));
        assert_eq!(
            answer(Problem::StaleKey),
            Answer::Refused {
                reason: relay::FinalReason::StaleKey
            }
        );
        assert_eq!(
            answer(Problem::BelowFee),
            Answer::Refused {
                reason: relay::FinalReason::BelowFee
            }
        );
        assert!(matches!(answer(Problem::Paused), Answer::Retry { .. }));
        assert_eq!(
            answer(Problem::CapExhausted(30)),
            Answer::Retry { retry_after: 30 }
        );
        assert!(matches!(
            answer(Refusal::RateLimited.into()),
            Answer::Retry { .. }
        ));
    }

    #[test]
    fn the_state_the_program_keeps_is_read_back() {
        let mut data = account_discriminator("ZkMint").to_vec();
        for value in [500u64, 50, 7] {
            data.extend_from_slice(&value.to_le_bytes());
        }
        data.extend_from_slice(&[6; 32]);
        for value in [100i64, 20, 30] {
            data.extend_from_slice(&value.to_le_bytes());
        }
        data.push(255);
        let mint = ZkMint::from_bytes(&data).unwrap();
        assert_eq!(
            (mint.global_cap, mint.lock_cap, mint.record_fee),
            (500, 50, 7)
        );
        assert_eq!(mint.fee_account, Pubkey::new_from_array([6; 32]));
        assert_eq!(
            mint.window,
            Window {
                start: 100,
                cur: 20,
                prev: 30
            }
        );
        data[0] ^= 1;
        assert!(ZkMint::from_bytes(&data).is_none());
    }

    proptest! {
        #[test]
        fn a_window_admits_at_most_two_caps_in_any_interval(
            steps in prop::collection::vec((0i64..30_000, 0u64..60), 1..300)
        ) {
            const LEN: i64 = 86_400;
            const CAP: u64 = 100;
            let (mut window, mut now, mut admitted) = (Window::default(), 0i64, Vec::new());
            for (dt, amount) in steps {
                now += dt;
                if window.admit(now, amount, CAP, LEN).is_ok() {
                    admitted.push((now, amount));
                }
                prop_assert!(window.cur <= CAP);
            }
            for &(start, _) in &admitted {
                let sum: u64 = admitted
                    .iter()
                    .filter(|(t, _)| *t >= start && *t < start + LEN)
                    .map(|(_, a)| a)
                    .sum();
                prop_assert!(sum <= 2 * CAP, "{sum} admitted in one window");
            }
        }

        #[test]
        fn a_checked_window_is_not_changed_and_agrees_with_admitting(
            cur in 0u64..100, prev in 0u64..100, start in 0i64..200_000,
            now in 0i64..400_000, amount in 0u64..100
        ) {
            let window = Window { start, cur, prev };
            let mut admitted = window;
            let verdict = window.check(now, amount, 100, 86_400);
            prop_assert_eq!(verdict.is_ok(), admitted.admit(now, amount, 100, 86_400).is_ok());
        }
    }
}
