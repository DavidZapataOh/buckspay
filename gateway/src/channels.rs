//! `POST /v1/channels`: the delivery words a relayer holds, settled into the reward pool by one
//! `settle_channel` transaction the gateway pays for. The relayer sends the words and one blinded
//! inner per exponent of the canonical decomposition of their number; the gateway knows the payer
//! of each channel from the word it released, so the relayer never learns it.
use crate::{
    chain::{CLOCK_SYSVAR, SIGNATURE_FEE},
    fees::priority_fee,
    jobs::write_atomic,
    limits::Prefix,
    onboard::{chain_now, local_now, read},
    server::{Client, Error, Gateway},
    settlements::{
        COMPUTE_UNIT_CEILING, MIN_COMPUTE_UNIT_LIMIT, compose, loaded_accounts_limit,
        loaded_accounts_size,
    },
    sponsored::{Outcome, confirm, unreachable},
    transactions::chain_verification,
    words::ChannelRecord,
};
use axum::{
    Extension, Json,
    body::Bytes,
    extract::{Path, State},
};
use base64::{Engine, prelude::BASE64_STANDARD};
use buckspay_client::{
    Program,
    accounts::{Channel, RewardMint},
    instructions::{CloseChannelBuilder, SettleChannelBuilder},
    types::{ChannelWords, WireWord},
};
use buckspay_protocol::{
    hash::{domain, purpose},
    payword::{self, Commitment, MAX_WORDS_PER_TX, WordProof},
    secp256r1,
};
use buckspay_zk_verify::fr::MODULUS;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;
use solana_rpc_client_api::config::{RpcSimulateTransactionConfig, RpcTransactionConfig};
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction_error::TransactionError;
use solana_transaction_status_client_types::UiTransactionEncoding;
use std::{
    collections::{BTreeMap, HashMap},
    io,
    path::{Path as FsPath, PathBuf},
    str::FromStr,
    sync::{Arc, Mutex},
};
use tracing::{info, warn};

/// Channels one transaction settles: three channels of four words are the most that fit 4,096
/// bytes.
pub const MAX_CHANNELS_PER_TX: usize = 3;
/// Open `Channel` accounts the gateway pays rent for, at most.
pub const MAX_OPEN_CHANNELS: usize = 1_000;
/// Channels a network may have the gateway open in one day.
pub const NEW_CHANNELS_PER_IP_DAY: u32 = 10;
/// The most lamports one transaction may cost the gateway: its fee and the rent of the channels it
/// creates.
pub const MAX_LAMPORTS_PER_TX: u64 = 10_000_000;
/// Where a channel account says who paid its rent, and when it may be closed.
pub const CHANNEL_PAYER_OFFSET: usize = 157;
pub const CHANNEL_CLOSABLE_OFFSET: usize = 189;
/// The largest body of `POST /v1/channels`.
pub const BODY_LIMIT: usize = 16 * 1024;
/// Transactions of this protocol may not exceed this many bytes.
const MAX_TRANSACTION_BYTES: usize = 4_096;
const RETRY_AFTER: u64 = 600;
const KEEP_ENDED: u32 = 86_400;
const SECONDS_PER_DAY: u32 = 86_400;
const INSTRUCTIONS_SYSVAR: &str = "Sysvar1nstructions1111111111111111111111111";

/// What bounds the channels the gateway opens, and the jobs that settle words.
pub struct Channels {
    pub max_per_tx: usize,
    pub max_open: usize,
    pub new_per_network_day: u32,
    new_today: Mutex<HashMap<Prefix, (u32, u32)>>,
    jobs: ChannelJobs,
}

impl Default for Channels {
    fn default() -> Self {
        Self::new(
            MAX_OPEN_CHANNELS,
            NEW_CHANNELS_PER_IP_DAY,
            ChannelJobs::default(),
        )
    }
}

impl Channels {
    pub fn new(max_open: usize, new_per_network_day: u32, jobs: ChannelJobs) -> Self {
        Self {
            max_per_tx: MAX_CHANNELS_PER_TX,
            max_open,
            new_per_network_day,
            new_today: Mutex::default(),
            jobs,
        }
    }

    /// The channels of this kind the gateway has opened in this day by `prefix`, counted with `new`
    /// more: `false` when that is over the day's limit, and nothing is counted then.
    fn admit_new(&self, prefix: Prefix, new: u32, day: u32) -> bool {
        let mut counts = self.new_today.lock().unwrap();
        counts.retain(|_, (counted, _)| *counted == day);
        let entry = counts.entry(prefix).or_insert((day, 0));
        match entry.1.checked_add(new) {
            Some(total) if total <= self.new_per_network_day => {
                entry.1 = total;
                true
            }
            _ => false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum JobState {
    Pending,
    Settled,
    Failed(String),
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ChannelJob {
    pub key: String,
    pub created_at: u32,
    pub state: JobState,
    /// Channels this job opens, counted against the open-channel cap while it is pending.
    pub new_channels: u32,
    pub words: u32,
    pub body: String,
    pub signature: Option<String>,
    pub leaf_indexes: Vec<u32>,
    pub compute_units: Option<u64>,
    pub bytes: Option<usize>,
}

/// The jobs that settle words, written before they are sent. A restart keeps them.
#[derive(Default)]
pub struct ChannelJobs {
    path: Option<PathBuf>,
    rows: Mutex<BTreeMap<String, ChannelJob>>,
}

impl ChannelJobs {
    pub fn open(path: &FsPath) -> Result<Self, String> {
        let rows = match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => BTreeMap::new(),
            Err(e) => return Err(e.to_string()),
        };
        Ok(Self {
            path: Some(path.to_owned()),
            rows: Mutex::new(rows),
        })
    }

    fn save(&self, rows: &BTreeMap<String, ChannelJob>) -> io::Result<()> {
        match &self.path {
            Some(path) => write_atomic(path, rows),
            None => Ok(()),
        }
    }

    pub fn get(&self, key: &str) -> Option<ChannelJob> {
        self.rows.lock().unwrap().get(key).cloned()
    }

    fn pending(&self) -> Vec<ChannelJob> {
        self.rows
            .lock()
            .unwrap()
            .values()
            .filter(|job| job.state == JobState::Pending)
            .cloned()
            .collect()
    }

    fn pending_new(&self) -> u64 {
        self.pending()
            .iter()
            .map(|job| u64::from(job.new_channels))
            .sum()
    }

    /// Writes a job down, unless the same job is pending: `false` says this call did not write it.
    fn begin(&self, job: ChannelJob) -> io::Result<bool> {
        let mut rows = self.rows.lock().unwrap();
        let now = job.created_at;
        rows.retain(|_, row| {
            row.state == JobState::Pending || row.created_at.saturating_add(KEEP_ENDED) > now
        });
        if rows
            .get(&job.key)
            .is_some_and(|row| row.state == JobState::Pending)
        {
            return Ok(false);
        }
        rows.insert(job.key.clone(), job);
        self.save(&rows)?;
        Ok(true)
    }

    fn update(&self, key: &str, change: impl FnOnce(&mut ChannelJob)) -> io::Result<()> {
        let mut rows = self.rows.lock().unwrap();
        if let Some(job) = rows.get_mut(key) {
            change(job);
            self.save(&rows)?;
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct Request {
    channels: Vec<Entry>,
    inners: Vec<String>,
}

#[derive(Deserialize)]
struct Entry {
    /// The signed commitment of the channel, base64.
    commitment: String,
    /// Word proofs, base64.
    words: Vec<String>,
}

/// A request that holds together without asking the chain anything.
#[derive(Debug, PartialEq)]
pub struct Batch {
    channels: Vec<Parsed>,
    inners: Vec<[u8; 32]>,
}

#[derive(Debug, PartialEq)]
struct Parsed {
    commitment: Commitment,
    bytes: [u8; payword::COMMITMENT_LEN],
    hash: [u8; 32],
    words: Vec<WordProof>,
}

impl Batch {
    fn words(&self) -> u32 {
        self.channels.iter().map(|c| c.words.len() as u32).sum()
    }

    /// What the request names, so that the same words are the same job.
    fn key(&self) -> String {
        let mut hash = Sha256::new();
        for channel in &self.channels {
            hash.update(channel.hash);
            for word in &channel.words {
                hash.update(word.index.to_be_bytes());
            }
            hash.update([0xff]);
        }
        for inner in &self.inners {
            hash.update(inner);
        }
        hex::encode(&hash.finalize()[..16])
    }
}

fn decode(value: &str) -> Result<Vec<u8>, &'static str> {
    BASE64_STANDARD
        .decode(value)
        .map_err(|_| "a field is not base64")
}

/// Checks everything about a request that does not need the chain: its sizes, that each word
/// verifies under its commitment's root, that the inners are the canonical number and below the
/// field modulus.
fn parse(request: &Request, max_channels: usize) -> Result<Batch, &'static str> {
    if request.channels.is_empty() || request.channels.len() > max_channels {
        return Err("a transaction settles one to three channels");
    }
    let mut channels: Vec<Parsed> = Vec::with_capacity(request.channels.len());
    for entry in &request.channels {
        let bytes: [u8; payword::COMMITMENT_LEN] = decode(&entry.commitment)?
            .try_into()
            .map_err(|_| "a commitment is not 91 bytes")?;
        let commitment = Commitment::decode(&bytes).map_err(|_| "a commitment does not decode")?;
        let hash = commitment.hash();
        if channels.iter().any(|c| c.hash == hash) {
            return Err("a channel is named twice");
        }
        let capacity = 1usize << commitment.depth;
        if entry.words.is_empty() || entry.words.len() > capacity {
            return Err("a channel holds one word or more, up to its depth");
        }
        let mut words: Vec<WordProof> = Vec::with_capacity(entry.words.len());
        for word in &entry.words {
            let proof = WordProof::decode(&decode(word)?, commitment.depth)
                .map_err(|_| "a word proof does not decode")?;
            if !payword::verify_word(&commitment.root, commitment.depth, &proof) {
                return Err("a word does not verify under its commitment");
            }
            if words.iter().any(|w| w.index == proof.index) {
                return Err("a word is named twice");
            }
            words.push(proof);
        }
        channels.push(Parsed {
            commitment,
            bytes,
            hash,
            words,
        });
    }
    let total: u32 = channels.iter().map(|c| c.words.len() as u32).sum();
    if total > MAX_WORDS_PER_TX {
        return Err("too many words in one transaction");
    }
    let exps = payword::canonical_exps(total).ok_or("the words are an odd number")?;
    if request.inners.len() != exps.len() {
        return Err("one inner per exponent of the words' number");
    }
    let mut inners = Vec::with_capacity(exps.len());
    for inner in &request.inners {
        let inner: [u8; 32] = decode(inner)?
            .try_into()
            .map_err(|_| "an inner is not 32 bytes")?;
        if inner >= MODULUS {
            return Err("an inner is not below the field modulus");
        }
        inners.push(inner);
    }
    Ok(Batch { channels, inners })
}

/// How a batch ends for good, or may be tried again.
#[derive(Debug, PartialEq)]
enum Verdict {
    Final(&'static str),
    Retry(u64),
}

impl From<Error> for Verdict {
    fn from(error: Error) -> Self {
        match error {
            Error::Rejected => Verdict::Final("rejected"),
            _ => Verdict::Retry(RETRY_AFTER),
        }
    }
}

/// A batch ready to send.
struct Plan {
    instructions: Vec<Instruction>,
    new_channels: u32,
}

fn issuer_of(record: &ChannelRecord) -> Result<[u8; 33], Verdict> {
    record
        .issuer
        .as_slice()
        .try_into()
        .map_err(|_| Verdict::Final("invalid"))
}

fn instructions_sysvar() -> Pubkey {
    Pubkey::from_str(INSTRUCTIONS_SYSVAR).expect("a sysvar address")
}

fn channel_address(state: &Gateway, lock: &Pubkey, hash: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(
        &[b"channel", lock.as_ref(), hash],
        &state.settings.program.id(),
    )
    .0
}

fn reward_mint_address(state: &Gateway) -> Pubkey {
    Pubkey::find_program_address(
        &[b"reward-mint", state.settings.mint.as_ref()],
        &state.settings.program.id(),
    )
    .0
}

/// Builds `settle_channel` for a batch from what the chain says now: the channels that exist keep
/// their stored root, the others carry their commitment and its signature.
async fn plan(state: &Gateway, batch: &Batch) -> Result<Plan, Verdict> {
    let program = state.settings.program;
    let reward_mint = reward_mint_address(state);
    let mut keys = vec![reward_mint, state.settings.mint, CLOCK_SYSVAR];
    let mut records = Vec::new();
    for channel in &batch.channels {
        let record = state
            .words
            .channel(&channel.hash)
            .ok_or(Verdict::Final("unknown_channel"))?;
        let lock = program
            .find_lock_pda(&issuer_of(&record)?, channel.commitment.lock_seq)
            .0;
        keys.extend([
            lock,
            program.find_ledger_pda(&lock).0,
            program.find_escrow_pda(&lock).0,
            channel_address(state, &lock, &channel.hash),
        ]);
        records.push((record, lock));
    }
    let accounts = read(state, &keys).await?;
    let reward = accounts[0]
        .as_ref()
        .and_then(|account| RewardMint::from_bytes(&account.data).ok())
        .ok_or(Verdict::Final("no_reward_pool"))?;
    let token_program = accounts[1]
        .as_ref()
        .map(|mint| mint.owner)
        .ok_or(Error::Upstream)?;
    chain_now(&accounts[2])?;
    let domain = domain(
        purpose::PAYWORD,
        &state.settings.genesis_hash,
        &program.id().to_bytes(),
    );
    let (mut words, mut remaining) = (Vec::new(), Vec::new());
    let (mut entries, mut signatures) = (Vec::new(), Vec::new());
    let mut new_channels = 0u32;
    for (i, (channel, (record, lock))) in batch.channels.iter().zip(&records).enumerate() {
        let [_, ledger, escrow, address] = [0, 1, 2, 3].map(|k| keys[3 + i * 4 + k]);
        let existing: Option<Channel> = accounts[3 + i * 4 + 3]
            .as_ref()
            .and_then(|account: &Account| Channel::from_bytes(&account.data).ok());
        for word in &channel.words {
            if !state.words.is_released(&channel.hash, word.index) {
                return Err(Verdict::Final("word_not_released"));
            }
            if existing.as_ref().is_some_and(|c| {
                c.settled[usize::from(word.index / 8)] >> (word.index % 8) & 1 == 1
            }) {
                return Err(Verdict::Final("settled"));
            }
        }
        let first = existing.is_none();
        let issuer: [u8; 33] = record
            .issuer
            .as_slice()
            .try_into()
            .map_err(|_| Verdict::Final("invalid"))?;
        if first {
            new_channels += 1;
            let envelope = payword::payword_signing(&domain, &channel.commitment)
                .map_err(|_| Verdict::Final("invalid"))?;
            entries.push((issuer, envelope));
            signatures.push(
                <[u8; 64]>::try_from(record.signature.as_slice())
                    .map_err(|_| Verdict::Final("invalid"))?,
            );
        }
        words.push(ChannelWords {
            issuer_key: issuer,
            lock_seq: channel.commitment.lock_seq,
            commitment: first.then_some(channel.bytes),
            words: channel
                .words
                .iter()
                .map(|w| WireWord {
                    index: w.index,
                    word: w.word,
                    path: w.path.clone(),
                })
                .collect(),
        });
        remaining.extend([
            AccountMeta::new_readonly(*lock, false),
            AccountMeta::new(ledger, false),
            AccountMeta::new(escrow, false),
            AccountMeta::new(address, false),
        ]);
    }
    let mut instructions = Vec::new();
    if !entries.is_empty() {
        let entries: Vec<secp256r1::Expected> = entries;
        instructions
            .push(chain_verification(&entries, &signatures).ok_or(Verdict::Final("invalid"))?);
    }
    let tree = Pubkey::find_program_address(
        &[
            b"reward-tree",
            reward.mint.as_ref(),
            &reward.epoch.to_le_bytes(),
        ],
        &program.id(),
    )
    .0;
    let mut builder = SettleChannelBuilder::new();
    builder
        .payer(state.fee_payer.pubkey())
        .reward_mint(reward_mint)
        .pool_ledger(program.find_ledger_pda(&reward_mint).0)
        .pool_escrow(program.find_escrow_pda(&reward_mint).0)
        .fee_account(reward.fee_account)
        .tree(tree)
        .mint(reward.mint)
        .instructions(instructions_sysvar())
        .token_program(token_program)
        .system_program(Pubkey::default())
        .channels(words)
        .inners(batch.inners.clone())
        .add_remaining_accounts(&remaining);
    instructions.push(program.target(builder.instruction()));
    Ok(Plan {
        instructions,
        new_channels,
    })
}

/// What the gateway paid for a sent transaction.
struct Sent {
    signature: Signature,
    compute_units: u64,
    bytes: usize,
}

/// Simulates the transaction, sends it as the fee payer and waits for its outcome. The fee and the
/// rent of the channels it creates are held to `MAX_LAMPORTS_PER_TX`.
async fn send(state: &Gateway, plan: &Plan, channel_rent: u64) -> Result<Sent, Verdict> {
    let fee_payer = state.fee_payer.pubkey();
    let (blockhash, _) = state
        .rpc
        .get_latest_blockhash_with_commitment(state.rpc.commitment())
        .await
        .map_err(unreachable)?;
    let recent = state
        .rpc
        .get_recent_prioritization_fees(&[fee_payer])
        .await
        .map_err(unreachable)?;
    let price = priority_fee(
        recent.iter().map(|fee| fee.prioritization_fee).collect(),
        state.settings.max_priority_fee,
    );
    let loaded = loaded_accounts_limit(loaded_accounts_size(state, &plan.instructions).await?);
    let priority = |limit: u32| price.saturating_mul(u64::from(limit)).div_ceil(1_000_000);
    let ceiling = COMPUTE_UNIT_CEILING.max(1_400_000);
    let draft = compose(
        state,
        &plan.instructions,
        blockhash,
        ceiling,
        loaded,
        priority(ceiling),
    )?;
    let bytes = draft.serialize().len() + 64;
    if bytes > MAX_TRANSACTION_BYTES {
        return Err(Verdict::Final("too_large"));
    }
    let simulation = state
        .rpc
        .simulate_transaction_with_config(
            &VersionedTransaction {
                signatures: vec![Signature::default()],
                message: draft,
            },
            RpcSimulateTransactionConfig {
                sig_verify: false,
                commitment: Some(state.rpc.commitment()),
                ..RpcSimulateTransactionConfig::default()
            },
        )
        .await
        .map_err(unreachable)?
        .value;
    if let Some(failure) = simulation.err {
        warn!(%failure, "a batch of words would fail");
        return Err(match TransactionError::from(failure) {
            TransactionError::InstructionError(..) => Verdict::Final("rejected"),
            _ => Verdict::Retry(RETRY_AFTER),
        });
    }
    let used = simulation.units_consumed.unwrap_or(0);
    let limit = u32::try_from(used + used * 3 / 10)
        .unwrap_or(ceiling)
        .clamp(MIN_COMPUTE_UNIT_LIMIT, ceiling);
    let signatures = u64::from(plan.instructions.len() > 1);
    let cost = SIGNATURE_FEE
        .saturating_mul(1 + signatures)
        .saturating_add(priority(limit))
        .saturating_add(channel_rent.saturating_mul(u64::from(plan.new_channels)));
    if cost > MAX_LAMPORTS_PER_TX {
        return Err(Verdict::Final("over_the_ceiling"));
    }
    let message = compose(
        state,
        &plan.instructions,
        blockhash,
        limit,
        loaded,
        priority(limit),
    )?;
    let transaction = VersionedTransaction {
        signatures: vec![state.fee_payer.sign_message(&message.serialize())],
        message,
    };
    let signature = state
        .rpc
        .send_transaction(&transaction)
        .await
        .map_err(|error| {
            if error.get_transaction_error().is_some() {
                Verdict::Final("rejected")
            } else {
                Verdict::Retry(RETRY_AFTER)
            }
        })?;
    match confirm(state, &signature).await {
        Outcome::Landed => Ok(Sent {
            signature,
            compute_units: used,
            bytes,
        }),
        Outcome::FailedOnChain => Err(Verdict::Final("failed")),
        Outcome::Unknown => Err(Verdict::Retry(RETRY_AFTER)),
    }
}

/// The indexes of the leaves a landed transaction appended, from its `LeafAppended` events.
async fn leaf_indexes(state: &Gateway, signature: &Signature) -> Vec<u32> {
    let Ok(fetched) = state
        .rpc
        .get_transaction_with_config(
            signature,
            RpcTransactionConfig {
                encoding: Some(UiTransactionEncoding::Base64),
                commitment: Some(state.rpc.commitment()),
                max_supported_transaction_version: Some(1),
            },
        )
        .await
    else {
        return Vec::new();
    };
    let logs = fetched
        .transaction
        .meta
        .and_then(|meta| Option::<Vec<String>>::from(meta.log_messages))
        .unwrap_or_default();
    leaves_in(&logs)
}

pub(crate) fn event_discriminator() -> [u8; 8] {
    Sha256::digest(b"event:LeafAppended")[..8]
        .try_into()
        .expect("a hash is longer than eight bytes")
}

/// The `index` of every `LeafAppended` event among `logs`.
fn leaves_in(logs: &[String]) -> Vec<u32> {
    let discriminator = event_discriminator();
    logs.iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .filter_map(|data| BASE64_STANDARD.decode(data).ok())
        .filter(|data| data.len() == 8 + 4 + 4 + 32 + 1 && data[..8] == discriminator)
        .map(|data| u32::from_le_bytes(data[12..16].try_into().expect("four bytes")))
        .collect()
}

fn answer(status: &str, extra: Value) -> Json<Value> {
    let mut body = json!({ "status": status });
    if let (Some(body), Value::Object(extra)) = (body.as_object_mut(), extra) {
        body.extend(extra);
    }
    Json(body)
}

fn retry(after: u64) -> Json<Value> {
    answer("retry", json!({ "retryAfter": after }))
}

fn refused(reason: &str) -> Json<Value> {
    answer("refused", json!({ "reason": reason }))
}

fn day(now: u32) -> u32 {
    now / SECONDS_PER_DAY
}

/// The accounts of the program of `size` bytes whose payer, at `offset`, is the gateway.
async fn open_channels(state: &Gateway) -> Result<Vec<(Pubkey, Account)>, Error> {
    crate::janitor::paid_by_us(state, Channel::LEN as u64, CHANNEL_PAYER_OFFSET).await
}

pub(crate) async fn post(
    State(state): State<Arc<Gateway>>,
    Extension(Client(ip)): Extension<Client>,
    body: Bytes,
) -> Json<Value> {
    if !state.relay.admit(ip) {
        return retry(60);
    }
    let Ok(request) = serde_json::from_slice::<Request>(&body) else {
        return refused("invalid");
    };
    let batch = match parse(&request, state.channels.max_per_tx) {
        Ok(batch) => batch,
        Err(reason) => {
            info!(reason, "a batch of words was refused");
            return refused("invalid");
        }
    };
    let key = batch.key();
    if state
        .channels
        .jobs
        .get(&key)
        .is_some_and(|job| job.state == JobState::Pending)
    {
        return answer("duplicate", json!({ "jobKey": key }));
    }
    let planned = match plan(&state, &batch).await {
        Ok(planned) => planned,
        Err(Verdict::Final(reason)) => return refused(reason),
        Err(Verdict::Retry(after)) => return retry(after),
    };
    let now = local_now();
    if planned.new_channels > 0 {
        let open = match open_channels(&state).await {
            Ok(open) => open.len() as u64,
            Err(_) => return retry(RETRY_AFTER),
        };
        let held = open
            .saturating_add(state.channels.jobs.pending_new())
            .saturating_add(u64::from(planned.new_channels));
        if held > state.channels.max_open as u64
            || !state
                .channels
                .admit_new(Prefix::from(ip), planned.new_channels, day(now))
        {
            return retry(RETRY_AFTER);
        }
    }
    let job = ChannelJob {
        key: key.clone(),
        created_at: now,
        state: JobState::Pending,
        new_channels: planned.new_channels,
        words: batch.words(),
        body: String::from_utf8_lossy(&body).into_owned(),
        signature: None,
        leaf_indexes: Vec::new(),
        compute_units: None,
        bytes: None,
    };
    match state.channels.jobs.begin(job) {
        Ok(true) => {
            let driven = Arc::clone(&state);
            let driving = key.clone();
            tokio::spawn(async move { drive(&driven, &driving).await });
            answer("submitted", json!({ "jobKey": key }))
        }
        Ok(false) => answer("duplicate", json!({ "jobKey": key })),
        Err(_) => {
            warn!("a channel job could not be written; nothing was sent");
            retry(RETRY_AFTER)
        }
    }
}

/// Sends a job's transaction from what the chain says now, and ends the job by its outcome. A job
/// whose words are all spent already was taken by another submitter.
pub(crate) async fn drive(state: &Gateway, key: &str) {
    let Some(job) = state.channels.jobs.get(key) else {
        return;
    };
    let Ok(request) = serde_json::from_str::<Request>(&job.body) else {
        end(state, key, JobState::Failed("invalid".into()));
        return;
    };
    let Ok(batch) = parse(&request, state.channels.max_per_tx) else {
        end(state, key, JobState::Failed("invalid".into()));
        return;
    };
    let rent = match state
        .rpc
        .get_minimum_balance_for_rent_exemption(Channel::LEN)
        .await
    {
        Ok(rent) => rent,
        Err(_) => return,
    };
    let outcome = match plan(state, &batch).await {
        Ok(planned) => send(state, &planned, rent).await,
        Err(verdict) => Err(verdict),
    };
    match outcome {
        Ok(sent) => {
            let indexes = leaf_indexes(state, &sent.signature).await;
            info!(
                units = sent.compute_units,
                bytes = sent.bytes,
                "words settled"
            );
            let signature = sent.signature.to_string();
            let _ = state.channels.jobs.update(key, |job| {
                job.state = JobState::Settled;
                job.signature = Some(signature);
                job.leaf_indexes = indexes;
                job.compute_units = Some(sent.compute_units);
                job.bytes = Some(sent.bytes);
            });
        }
        Err(Verdict::Final(reason)) => end(state, key, JobState::Failed(reason.into())),
        Err(Verdict::Retry(_)) => warn!("a channel job waits for the janitor"),
    }
}

fn end(state: &Gateway, key: &str, outcome: JobState) {
    if let Err(error) = state.channels.jobs.update(key, |job| job.state = outcome) {
        warn!(%error, "a channel job could not be written");
    }
}

/// `GET /v1/channels/{jobKey}`.
pub(crate) async fn status(
    State(state): State<Arc<Gateway>>,
    Path(key): Path<String>,
) -> Result<Json<Value>, Error> {
    let job = state.channels.jobs.get(&key).ok_or(Error::Gone)?;
    Ok(match job.state {
        JobState::Pending => answer("submitted", json!({ "jobKey": key })),
        JobState::Settled => answer(
            "settled",
            json!({
                "jobKey": key,
                "signature": job.signature,
                "leafIndexes": job.leaf_indexes,
                "words": job.words,
                "computeUnits": job.compute_units,
                "bytes": job.bytes,
            }),
        ),
        JobState::Failed(reason) => refused(&reason),
    })
}

/// The janitor's part: jobs that were written and not finished are sent again, and what has
/// outlived its window is forgotten.
pub(crate) async fn resume_pending(state: &Gateway) {
    for job in state.channels.jobs.pending() {
        drive(state, &job.key).await;
    }
    let _ = state.words.sweep(local_now());
}

/// Channels that may be closed now, as `(address, rent payer)`.
fn closable(open: &[(Pubkey, Account)], now: u32) -> Vec<(Pubkey, Pubkey)> {
    open.iter()
        .filter_map(|(address, account)| {
            let at = u32::from_le_bytes(
                account
                    .data
                    .get(CHANNEL_CLOSABLE_OFFSET..CHANNEL_CLOSABLE_OFFSET + 4)?
                    .try_into()
                    .ok()?,
            );
            let payer = Pubkey::try_from(
                account
                    .data
                    .get(CHANNEL_PAYER_OFFSET..CHANNEL_PAYER_OFFSET + 32)?,
            )
            .ok()?;
            (now >= at).then_some((*address, payer))
        })
        .collect()
}

/// The instructions that close the channels of `open` that are due, and return their rent.
pub(crate) fn closing(
    program: &Program,
    open: &[(Pubkey, Account)],
    now: u32,
    limit: usize,
) -> Vec<Instruction> {
    closable(open, now)
        .into_iter()
        .take(limit)
        .map(|(channel, payer)| {
            program.target(
                CloseChannelBuilder::new()
                    .channel(channel)
                    .payer(payer)
                    .instruction(),
            )
        })
        .collect()
}

/// A tree is full for settling when fewer than this many leaves still fit.
pub const TREE_CAPACITY: u32 = 1 << 20;
pub const LEAVES_PER_TX: u32 = payword::MAX_LEAVES_PER_TX as u32;

/// Whether `settle_channel` would refuse for a tree with `next_index` leaves.
pub fn tree_is_full(next_index: u32) -> bool {
    next_index > TREE_CAPACITY - LEAVES_PER_TX
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tree_is_full_when_the_biggest_batch_no_longer_fits() {
        assert!(!tree_is_full(TREE_CAPACITY - LEAVES_PER_TX));
        assert!(tree_is_full(TREE_CAPACITY - LEAVES_PER_TX + 1));
    }

    #[test]
    fn a_network_opens_at_most_its_daily_channels_and_the_count_resets_each_day() {
        let channels = Channels::new(10, 2, ChannelJobs::default());
        let (a, b) = (Prefix::V4([10, 0, 0]), Prefix::V4([10, 0, 1]));
        assert!(channels.admit_new(a, 1, 5));
        assert!(channels.admit_new(a, 1, 5));
        assert!(!channels.admit_new(a, 1, 5));
        assert!(channels.admit_new(b, 2, 5));
        assert!(!channels.admit_new(b, u32::MAX, 5), "the sum overflows");
        assert!(channels.admit_new(a, 1, 6), "a new day starts at zero");
    }

    #[test]
    fn leaf_events_are_read_from_the_logs_and_nothing_else_is() {
        let mut event = event_discriminator().to_vec();
        event.extend(7u32.to_le_bytes());
        event.extend(41u32.to_le_bytes());
        event.extend([9u8; 32]);
        event.push(3);
        let logs = vec![
            "Program log: settle".to_owned(),
            format!("Program data: {}", BASE64_STANDARD.encode(&event)),
            format!("Program data: {}", BASE64_STANDARD.encode([1u8; 45])),
        ];
        assert_eq!(leaves_in(&logs), vec![41]);
    }

    #[test]
    fn jobs_are_written_once_and_survive_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("channels.json");
        let job = ChannelJob {
            key: "k".into(),
            created_at: 10,
            state: JobState::Pending,
            new_channels: 1,
            words: 2,
            body: "{}".into(),
            signature: None,
            leaf_indexes: vec![],
            compute_units: None,
            bytes: None,
        };
        let jobs = ChannelJobs::open(&path).unwrap();
        assert!(jobs.begin(job.clone()).unwrap());
        assert!(!jobs.begin(job.clone()).unwrap());
        assert_eq!(jobs.pending_new(), 1);
        jobs.update("k", |job| job.state = JobState::Settled)
            .unwrap();
        let reopened = ChannelJobs::open(&path).unwrap();
        assert_eq!(reopened.get("k").unwrap().state, JobState::Settled);
        assert_eq!(reopened.pending_new(), 0);
    }
}
