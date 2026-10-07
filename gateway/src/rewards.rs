//! `POST /v1/claims` and `POST /v1/sweeps`: the reward claims a recipient with no SOL has the
//! gateway submit, and the sweep that moves claimed rewards out of that fresh address. Both are
//! paid for by the gateway, with the compute limit and price pinned in its configuration, and are
//! repaid in the mint by the on-chain `claim_fee` and the sweep's own fee at the admin's rate.
use crate::{
    chain::{
        ASSOCIATED_TOKEN_PROGRAM, CLOCK_SYSVAR, SIGNATURE_FEE, TOKEN_PROGRAM,
        associated_token_address,
    },
    channels::{JobState, MAX_LAMPORTS_PER_TX},
    jobs::write_atomic,
    limits::{Prefix, RequestLimits},
    onboard::{chain_now, local_now, read},
    relay::{Answer, FinalReason, answer_for},
    server::{Client, Error, Gateway},
    settlements::{Planned, Problem, compose, ended, loaded_accounts_limit, loaded_accounts_size},
    sponsored::{Outcome, confirm, unreachable},
};
use axum::{
    Extension, Json,
    body::Bytes,
    extract::{Path, State},
};
use base64::{Engine, prelude::BASE64_STANDARD};
use buckspay_client::{
    accounts::{RewardConfig, RewardMint, RewardTree},
    instructions::ClaimRewardsBuilder,
    types::OneClaim as WireClaim,
};
use buckspay_protocol::payword::{MAX_LEAF_EXP, MIN_LEAF_EXP};
use buckspay_zk_verify::{
    CLAIM_NUM_PUBLIC, CLAIM_PROOF_COMPRESSED, ClaimPublic, fr, verify_claims_with,
    vk::{self, Vk},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use solana_compute_budget_interface::{ComputeBudgetInstruction, ID as COMPUTE_BUDGET};
use solana_instruction::{AccountMeta, Instruction};
use solana_message::VersionedMessage;
use solana_pubkey::Pubkey;
use solana_rpc_client_api::config::RpcSimulateTransactionConfig;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction_error::TransactionError;
use std::{
    collections::BTreeMap,
    io,
    num::NonZeroU32,
    path::{Path as FsPath, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};
use tracing::{info, warn};

/// Claims one `claim_rewards` transaction pays: the program's own limit.
pub const MAX_CLAIMS_PER_TX: usize = 4;
/// The largest body of the reward endpoints.
pub const BODY_LIMIT: usize = 16 * 1024;
/// Claim requests one network may make in an hour. Per-network limits are weak behind shared
/// addresses and rented ones: what bounds the gateway is `Rewards::daily_budget`.
pub const CLAIMS_PER_IP_HOUR: u32 = 10;
/// Claim requests all networks together may make in an hour.
pub const CLAIMS_PER_HOUR: u32 = 200;
/// Sweep requests one network may make in an hour.
pub const SWEEPS_PER_IP_HOUR: u32 = 10;
/// The longest a signed sweep waits: its blockhash is gone soon after.
pub const SWEEP_TTL: u32 = 120;
const RETRY_AFTER: u64 = 600;
const KEEP_ENDED: u32 = 86_400;
const SECONDS_PER_DAY: u32 = 86_400;
/// The bucket every reward claim of all networks is also counted in, in the reserved block
/// 240.0.1.0/24 beside the relay's.
const ALL_CLAIMS: Prefix = Prefix::V4([240, 0, 1]);
const TRANSFER_CHECKED: u8 = 12;
const CREATE_IDEMPOTENT: u8 = 1;
const TOKEN_ACCOUNT_LEN: usize = 165;
const MAX_TRANSACTION_BYTES: usize = 1_232;

/// What a mint unit is worth in lamports, as the admin maintains it: `num / den` micro-units of
/// the mint per lamport. No oracle sits in the money path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rate {
    num: u64,
    den: u64,
}

impl Rate {
    pub const fn usdc_micro_per_lamport(num: u64, den: u64) -> Self {
        Self { num, den }
    }

    /// From micro-units of the mint per SOL.
    pub const fn per_sol(micro_units: u64) -> Self {
        Self::usdc_micro_per_lamport(micro_units, 1_000_000_000)
    }

    /// The least amount of the mint worth `lamports`.
    pub fn lamports_to_usdc(&self, lamports: u64) -> u64 {
        let worth = (u128::from(lamports) * u128::from(self.num)).div_ceil(u128::from(self.den));
        u64::try_from(worth).unwrap_or(u64::MAX)
    }
}

/// Whether `claims` claims paying `claim_fee` each cover `cost_lamports` at `rate`.
pub fn repaid(cost_lamports: u64, claims: u64, claim_fee: u64, rate: Rate) -> bool {
    u128::from(cost_lamports) * u128::from(rate.num)
        <= u128::from(claims) * u128::from(claim_fee) * u128::from(rate.den)
}

/// What the gateway's configuration fixes about every sponsored reward transaction: nothing in a
/// request sets them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pinned {
    pub claim_cu: u32,
    pub sweep_cu: u32,
    /// Micro-lamports per compute unit.
    pub priority_price: u64,
}

impl Pinned {
    /// The priority fee of a transaction with `units` as its limit, in lamports.
    pub fn priority_fee(&self, units: u32) -> u64 {
        let fee = (u128::from(self.priority_price) * u128::from(units)).div_ceil(1_000_000);
        u64::try_from(fee).unwrap_or(u64::MAX)
    }
}

/// What the accounts a claim creates cost, as the cluster says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClaimRents {
    /// A nullifier account: no data.
    pub nullifier: u64,
    /// A token account.
    pub token_account: u64,
}

/// What a claim transaction costs the gateway: its fee, the pinned priority fee, the recipient's
/// token account when it is created and a nullifier account per claim. Saturates, so that an
/// absurd figure only fails the ceiling.
pub fn claim_cost_lamports(p: &Pinned, claims: u64, creates_ata: bool, rents: &ClaimRents) -> u64 {
    SIGNATURE_FEE
        .saturating_add(p.priority_fee(p.claim_cu))
        .saturating_add(if creates_ata { rents.token_account } else { 0 })
        .saturating_add(claims.saturating_mul(rents.nullifier))
}

/// What a sweep costs the gateway: two signatures, the pinned priority fee and the destination's
/// token account when it is created.
pub fn sweep_cost_lamports(p: &Pinned, creates_ata: bool, rents: &ClaimRents) -> u64 {
    SIGNATURE_FEE
        .saturating_mul(2)
        .saturating_add(p.priority_fee(p.sweep_cu))
        .saturating_add(if creates_ata { rents.token_account } else { 0 })
}

/// Whether the on-chain `claim_fee` repays a one-claim transaction at `rate` and stays below the
/// value of the smallest leaf: the two bounds the fee lives between.
pub fn economics(
    p: &Pinned,
    rents: &ClaimRents,
    rate: Rate,
    claim_fee: u64,
    unit: u64,
) -> Result<(), String> {
    let cost = claim_cost_lamports(p, 1, true, rents);
    if !repaid(cost, 1, claim_fee, rate) {
        return Err(format!(
            "claim_fee {claim_fee} is below the cost of one claim, {} at the rate",
            rate.lamports_to_usdc(cost)
        ));
    }
    let smallest = unit.saturating_mul(1 << MIN_LEAF_EXP);
    if claim_fee >= smallest {
        return Err(format!(
            "claim_fee {claim_fee} is not below the smallest leaf, {smallest}"
        ));
    }
    Ok(())
}

/// What the sweep endpoint accepts, from the gateway's configuration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SweepConfig {
    pub pinned: Pinned,
    pub gateway: Pubkey,
    pub mint: Pubkey,
    pub decimals: u8,
    /// The token account the sweep fee goes to: configured, never taken from a request.
    pub fee_account: Pubkey,
    /// The least fee that repays a sweep to an existing token account, and one that creates it.
    pub sweep_fee: u64,
    pub sweep_fee_with_ata: u64,
}

impl SweepConfig {
    pub fn new(
        pinned: Pinned,
        gateway: Pubkey,
        mint: (Pubkey, u8),
        fee_account: Pubkey,
        rate: Rate,
        rents: &ClaimRents,
    ) -> Self {
        Self {
            pinned,
            gateway,
            mint: mint.0,
            decimals: mint.1,
            fee_account,
            sweep_fee: rate.lamports_to_usdc(sweep_cost_lamports(&pinned, false, rents)),
            sweep_fee_with_ata: rate.lamports_to_usdc(sweep_cost_lamports(&pinned, true, rents)),
        }
    }
}

/// What a sweep does, once it is known to be the one shape the gateway pays for.
#[derive(Debug, PartialEq, Eq)]
pub struct SweepPlan {
    pub fresh: Pubkey,
    pub creates_ata: bool,
    pub amount: u64,
    pub fee: u64,
}

pub fn associated(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    associated_token_address(owner, mint, &TOKEN_PROGRAM)
}

pub fn create_associated_idempotent(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey) -> Instruction {
    Instruction {
        program_id: ASSOCIATED_TOKEN_PROGRAM,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(associated(owner, mint), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(Pubkey::default(), false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        ],
        data: vec![CREATE_IDEMPOTENT],
    }
}

/// An instruction of a transaction with its accounts resolved.
struct Resolved<'a> {
    program: Pubkey,
    accounts: Vec<Pubkey>,
    data: &'a [u8],
}

struct Transfer {
    source: Pubkey,
    mint: Pubkey,
    destination: Pubkey,
    authority: Pubkey,
    amount: u64,
    decimals: u8,
}

fn transfer_of(ix: &Resolved) -> Option<Transfer> {
    let [source, mint, destination, authority] = ix.accounts[..] else {
        return None;
    };
    let [TRANSFER_CHECKED, amount @ .., decimals] = ix.data else {
        return None;
    };
    (ix.program == TOKEN_PROGRAM).then_some(Transfer {
        source,
        mint,
        destination,
        authority,
        amount: u64::from_le_bytes(amount.try_into().ok()?),
        decimals: *decimals,
    })
}

fn bad(reason: &'static str) -> Problem {
    Problem::Invalid(reason)
}

/// Accepts a sweep only if it is exactly the shape the gateway pays for: the pinned compute limit
/// and price, an optional idempotent creation of the destination's token account paid by the
/// gateway, one transfer of the mint from the fresh address's own token account, and one transfer
/// of at least the sweep fee to the configured fee account. The gateway is the fee payer and
/// appears nowhere else, no address lookup table is used and the fresh address is the only other
/// signer.
pub fn check_sweep(tx: &VersionedTransaction, cfg: &SweepConfig) -> Result<SweepPlan, Problem> {
    let VersionedMessage::V0(message) = &tx.message else {
        return Err(bad("a sweep is a v0 transaction"));
    };
    let keys = &message.account_keys;
    if !message.address_table_lookups.is_empty()
        || message.header.num_required_signatures != 2
        || tx.signatures.len() != 2
        || keys.len() < 3
        || keys[0] != cfg.gateway
    {
        return Err(bad("the gateway pays and the fresh address alone signs"));
    }
    let fresh = keys[1];
    let mut ixs = Vec::with_capacity(message.instructions.len());
    for ix in &message.instructions {
        let account = |i: &u8| keys.get(usize::from(*i)).copied();
        ixs.push(Resolved {
            program: keys
                .get(usize::from(ix.program_id_index))
                .copied()
                .ok_or(bad("an instruction names no program"))?,
            accounts: ix
                .accounts
                .iter()
                .map(account)
                .collect::<Option<_>>()
                .ok_or(bad("an instruction names no account"))?,
            data: &ix.data,
        });
    }
    let pinned = &cfg.pinned;
    let compute = |ix: &Resolved, expected: Instruction| {
        ix.program == COMPUTE_BUDGET && ix.accounts.is_empty() && ix.data == expected.data
    };
    let creates_ata = match ixs.len() {
        4 => false,
        5 => true,
        _ => return Err(bad("a sweep has four or five instructions")),
    };
    if !compute(
        &ixs[0],
        ComputeBudgetInstruction::set_compute_unit_limit(pinned.sweep_cu),
    ) || !compute(
        &ixs[1],
        ComputeBudgetInstruction::set_compute_unit_price(pinned.priority_price),
    ) {
        return Err(bad("the compute limit and price are the gateway's"));
    }
    let transfers = &ixs[ixs.len() - 2..];
    let first = transfer_of(&transfers[0]).ok_or(bad("the first instruction moves no tokens"))?;
    let fee = transfer_of(&transfers[1]).ok_or(bad("the last instruction moves no tokens"))?;
    let mut destination = first.destination;
    if creates_ata {
        let ata = &ixs[2];
        let [payer, token, owner, mint, system, program] = ata.accounts[..] else {
            return Err(bad("a token account creation has six accounts"));
        };
        if ata.program != ASSOCIATED_TOKEN_PROGRAM
            || ata.data != [CREATE_IDEMPOTENT]
            || payer != cfg.gateway
            || mint != cfg.mint
            || system != Pubkey::default()
            || program != TOKEN_PROGRAM
            || token != associated(&owner, &mint)
            || token != first.destination
        {
            return Err(bad("the token account created is not the destination"));
        }
        destination = token;
    }
    let source = associated(&fresh, &cfg.mint);
    for transfer in [&first, &fee] {
        if transfer.mint != cfg.mint
            || transfer.decimals != cfg.decimals
            || transfer.authority != fresh
            || transfer.source != source
            || transfer.amount == 0
        {
            return Err(bad("a transfer is not of the mint from the fresh address"));
        }
    }
    let minimum = if creates_ata {
        cfg.sweep_fee_with_ata
    } else {
        cfg.sweep_fee
    };
    if fee.destination != cfg.fee_account || fee.amount < minimum || destination == source {
        return Err(bad("the fee is not paid to the fee account in full"));
    }
    let gateway_slots = ixs
        .iter()
        .flat_map(|ix| &ix.accounts)
        .filter(|key| **key == cfg.gateway)
        .count();
    if gateway_slots != usize::from(creates_ata) {
        return Err(bad(
            "the gateway is named only as the payer of the creation",
        ));
    }
    let referenced = |key: &Pubkey| {
        ixs.iter()
            .any(|ix| ix.program == *key || ix.accounts.contains(key))
    };
    if !keys[1..].iter().all(referenced) {
        return Err(bad("an account is named and not used"));
    }
    Ok(SweepPlan {
        fresh,
        creates_ata,
        amount: first.amount,
        fee: fee.amount,
    })
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaimEntry {
    pub epoch: u32,
    pub root: String,
    pub nullifier_hash: String,
    pub exp: u8,
    pub proof: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaimBody {
    pub vk_sha256: String,
    pub recipient: String,
    pub max_fee: u64,
    pub claims: Vec<ClaimEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OneClaim {
    pub epoch: u32,
    pub root: [u8; 32],
    pub nullifier_hash: [u8; 32],
    pub exp: u8,
    pub proof: [u8; CLAIM_PROOF_COMPRESSED],
}

/// A request that holds together without asking the chain anything.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaimRequest {
    pub vk_sha256: [u8; 32],
    pub recipient: Pubkey,
    pub max_fee: u64,
    pub claims: Vec<OneClaim>,
}

impl ClaimRequest {
    pub fn nullifiers(&self) -> Vec<[u8; 32]> {
        self.claims.iter().map(|c| c.nullifier_hash).collect()
    }
}

fn decode<const N: usize>(value: &str, what: &'static str) -> Result<[u8; N], Problem> {
    BASE64_STANDARD
        .decode(value)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(Problem::Invalid(what))
}

/// Checks the sizes and the shape of a claim body: one to four claims, 32-byte values below the
/// field modulus, 128-byte proofs, denominations in range and no nullifier twice.
pub fn parse_claim(body: &[u8]) -> Result<ClaimRequest, Problem> {
    let body: ClaimBody = serde_json::from_slice(body).map_err(|_| bad("not a claim request"))?;
    if body.claims.is_empty() || body.claims.len() > MAX_CLAIMS_PER_TX {
        return Err(bad("a transaction claims one to four leaves"));
    }
    let mut claims: Vec<OneClaim> = Vec::with_capacity(body.claims.len());
    for entry in &body.claims {
        let claim = OneClaim {
            epoch: entry.epoch,
            root: decode(&entry.root, "a root is not 32 bytes")?,
            nullifier_hash: decode(&entry.nullifier_hash, "a nullifier is not 32 bytes")?,
            exp: entry.exp,
            proof: decode(&entry.proof, "a proof is not 128 bytes")?,
        };
        if !(MIN_LEAF_EXP..=MAX_LEAF_EXP).contains(&claim.exp)
            || !fr::is_canonical(&claim.root)
            || !fr::is_canonical(&claim.nullifier_hash)
            || claims
                .iter()
                .any(|c| c.nullifier_hash == claim.nullifier_hash)
        {
            return Err(bad("a claim is out of range or repeated"));
        }
        claims.push(claim);
    }
    Ok(ClaimRequest {
        vk_sha256: decode(&body.vk_sha256, "the key hash is not 32 bytes")?,
        recipient: body
            .recipient
            .parse()
            .map_err(|_| bad("the recipient is not an address"))?,
        max_fee: body.max_fee,
        claims,
    })
}

/// What a claim names, so that the same leaves are the same job: the nullifiers, in any order,
/// and never the proof bytes, which differ between two proofs of the same leaf.
pub fn claim_job_key(nullifiers: &[[u8; 32]]) -> [u8; 32] {
    let mut sorted = nullifiers.to_vec();
    sorted.sort_unstable();
    let mut hash = Sha256::new();
    for nullifier in sorted {
        hash.update(nullifier);
    }
    hash.finalize().into()
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Claim,
    Sweep,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RewardJob {
    pub key: String,
    pub kind: Kind,
    pub created_at: u32,
    pub state: JobState,
    /// What the gateway pays for this job at most, counted in the day's budget while it holds.
    pub cost_lamports: u64,
    /// The request: a claim body, or the base64 of a signed sweep.
    pub body: String,
    /// The fresh address a sweep spends from.
    pub fresh: Option<String>,
    pub signature: Option<String>,
    pub last_valid_block_height: Option<u64>,
    pub compute_units: Option<u64>,
}

/// The reward jobs, written before they are sent. A restart keeps them.
#[derive(Default)]
pub struct RewardJobs {
    path: Option<PathBuf>,
    rows: Mutex<BTreeMap<String, RewardJob>>,
}

impl RewardJobs {
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

    fn save(&self, rows: &BTreeMap<String, RewardJob>) -> io::Result<()> {
        self.path
            .as_ref()
            .map_or(Ok(()), |path| write_atomic(path, rows))
    }

    pub fn get(&self, key: &str) -> Option<RewardJob> {
        self.rows.lock().unwrap().get(key).cloned()
    }

    fn pending(&self) -> Vec<RewardJob> {
        let rows = self.rows.lock().unwrap();
        rows.values()
            .filter(|job| job.state == JobState::Pending)
            .cloned()
            .collect()
    }

    fn sweeping(&self, fresh: &Pubkey) -> bool {
        let fresh = fresh.to_string();
        self.pending()
            .iter()
            .any(|job| job.fresh.as_deref() == Some(&fresh))
    }

    /// What the day's jobs have cost or may still cost: those that ended before anything was
    /// sent cost nothing.
    fn committed_on(&self, day: u32) -> u64 {
        let rows = self.rows.lock().unwrap();
        rows.values()
            .filter(|job| job.created_at / SECONDS_PER_DAY == day)
            .filter(|job| {
                job.state == JobState::Pending
                    || job.state == JobState::Settled
                    || job.signature.is_some()
            })
            .fold(0u64, |sum, job| sum.saturating_add(job.cost_lamports))
    }

    /// Writes a job down, unless the same job is pending: `false` says this call did not write it.
    fn begin(&self, job: RewardJob) -> io::Result<bool> {
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

    fn update(&self, key: &str, change: impl FnOnce(&mut RewardJob)) -> io::Result<()> {
        let mut rows = self.rows.lock().unwrap();
        if let Some(job) = rows.get_mut(key) {
            change(job);
            self.save(&rows)?;
        }
        Ok(())
    }
}

/// What bounds the reward endpoints, and the jobs they write.
pub struct Rewards {
    pub pinned: Pinned,
    /// `None` while the admin has not set a rate: the endpoints answer `retry`.
    pub rate: Option<Rate>,
    /// Lamports the reward jobs of one day may cost the gateway, all together.
    pub daily_budget: u64,
    claim_ip: RequestLimits,
    claim_all: RequestLimits,
    sweep_ip: RequestLimits,
    claim_ip_limit: u32,
    verified: AtomicU64,
    rents: Mutex<Option<ClaimRents>>,
    jobs: RewardJobs,
    driving: Mutex<Vec<String>>,
}

impl Default for Rewards {
    fn default() -> Self {
        Self::new(
            Pinned {
                claim_cu: 400_000,
                sweep_cu: 40_000,
                priority_price: 10_000,
            },
            None,
            0,
            RewardJobs::default(),
        )
    }
}

fn per_hour(limit: u32) -> RequestLimits {
    RequestLimits::per_hour(NonZeroU32::new(limit).expect("a limit is not zero"))
}

impl Rewards {
    pub fn new(pinned: Pinned, rate: Option<Rate>, daily_budget: u64, jobs: RewardJobs) -> Self {
        Self {
            pinned,
            rate,
            daily_budget,
            claim_ip: per_hour(CLAIMS_PER_IP_HOUR),
            claim_all: per_hour(CLAIMS_PER_HOUR),
            sweep_ip: per_hour(SWEEPS_PER_IP_HOUR),
            claim_ip_limit: CLAIMS_PER_IP_HOUR,
            verified: AtomicU64::new(0),
            rents: Mutex::default(),
            jobs,
            driving: Mutex::default(),
        }
    }

    /// The same with a claim limit per network of `limit` an hour.
    pub fn with_claim_ip_limit(mut self, limit: u32) -> Self {
        self.claim_ip = per_hour(limit);
        self.claim_ip_limit = limit;
        self
    }

    pub fn claim_ip_limit(&self) -> u32 {
        self.claim_ip_limit
    }

    /// How many claim batches were verified natively.
    pub fn verifications(&self) -> u64 {
        self.verified.load(Ordering::Relaxed)
    }

    pub fn job(&self, key: &str) -> Option<RewardJob> {
        self.jobs.get(key)
    }

    fn admit_claim(&self, prefix: Prefix) -> bool {
        self.claim_ip.check(prefix).is_ok() && self.claim_all.check(ALL_CLAIMS).is_ok()
    }

    async fn rents(&self, state: &Gateway) -> Result<ClaimRents, Error> {
        if let Some(rents) = *self.rents.lock().unwrap() {
            return Ok(rents);
        }
        let rent = |len: usize| async move {
            state
                .rpc
                .get_minimum_balance_for_rent_exemption(len)
                .await
                .map_err(unreachable)
        };
        let rents = ClaimRents {
            nullifier: rent(0).await?,
            token_account: rent(TOKEN_ACCOUNT_LEN).await?,
        };
        *self.rents.lock().unwrap() = Some(rents);
        Ok(rents)
    }

    /// Takes the job for this task, unless another task is sending it.
    fn drive(&self, key: &str) -> Option<Driving<'_>> {
        let mut driving = self.driving.lock().unwrap();
        if driving.iter().any(|k| k == key) {
            return None;
        }
        driving.push(key.to_owned());
        Some(Driving {
            rewards: self,
            key: key.to_owned(),
        })
    }
}

struct Driving<'a> {
    rewards: &'a Rewards,
    key: String,
}

impl Drop for Driving<'_> {
    fn drop(&mut self) {
        self.rewards
            .driving
            .lock()
            .unwrap()
            .retain(|key| *key != self.key);
    }
}

fn address(state: &Gateway, seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &state.settings.program.id()).0
}

fn nullifier_address(state: &Gateway, hash: &[u8; 32]) -> Pubkey {
    address(state, &[b"reward-null", state.settings.mint.as_ref(), hash])
}

fn word(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(bytes);
    out
}

/// The key a claim batch is verified under, as the program picks it: the current key, or the
/// previous one inside its window.
fn claim_key(config: &RewardConfig, sha256: &[u8; 32], now: u32) -> Option<Vk<'static>> {
    if sha256 == vk::CLAIM.sha256 {
        return (config.claim_key.vk == *sha256).then_some(vk::CLAIM);
    }
    let overlap = 72 * 3600 + 3600;
    vk::CLAIM_PREVIOUS.filter(|key| {
        key.sha256 == sha256
            && config.previous_claim_key.vk == *sha256
            && config.rotated_at != 0
            && i64::from(now) <= config.rotated_at.saturating_add(overlap)
    })
}

/// A claim ready to send.
struct PlannedClaim {
    instructions: Vec<Instruction>,
    cost_lamports: u64,
}

fn refuse(problem: Problem) -> Error {
    Error::Settlement(problem)
}

/// Checks a claim against the chain as it is now and builds the transaction: the reward pool is
/// configured and not paused, the key is current, the fee is the mint's fixed `max_fee`, every
/// nullifier is unspent and every root known; only then are the proofs verified natively, and the
/// claim is accepted only when the gateway is repaid what it pays at the admin's rate.
async fn plan_claim(
    state: &Gateway,
    request: &ClaimRequest,
    verify: bool,
) -> Result<PlannedClaim, Error> {
    let rewards = &state.rewards;
    let rate = rewards.rate.ok_or(refuse(Problem::Paused))?;
    let program = state.settings.program;
    let mint = state.settings.mint;
    let recipient_token = associated(&request.recipient, &mint);
    let (config_key, reward_key) = (
        address(state, &[b"reward-config"]),
        address(state, &[b"reward-mint", mint.as_ref()]),
    );
    let mut keys = vec![config_key, reward_key, mint, CLOCK_SYSVAR, recipient_token];
    for claim in &request.claims {
        keys.push(address(
            state,
            &[b"reward-tree", mint.as_ref(), &claim.epoch.to_le_bytes()],
        ));
        keys.push(nullifier_address(state, &claim.nullifier_hash));
    }
    let accounts = read(state, &keys).await?;
    let decoded = |i: usize| accounts[i].as_ref().map(|account| &account.data[..]);
    let config = decoded(0)
        .and_then(|data| RewardConfig::from_bytes(data).ok())
        .ok_or(refuse(Problem::Paused))?;
    let reward = decoded(1)
        .and_then(|data| RewardMint::from_bytes(data).ok())
        .ok_or(refuse(Problem::Paused))?;
    if config.paused || accounts[2].as_ref().map(|mint| mint.owner) != Some(TOKEN_PROGRAM) {
        return Err(refuse(Problem::Paused));
    }
    let now = chain_now(&accounts[3])?;
    let key = claim_key(&config, &request.vk_sha256, now).ok_or(refuse(Problem::StaleKey))?;
    if request.max_fee != reward.max_fee || reward.claim_fee > request.max_fee {
        return Err(refuse(Problem::Fee));
    }
    for (i, claim) in request.claims.iter().enumerate() {
        if accounts[6 + i * 2].is_some() {
            return Err(refuse(Problem::Spent));
        }
        let tree = decoded(5 + i * 2)
            .and_then(|data| RewardTree::from_bytes(data).ok())
            .ok_or(bad("a tree is not on chain"))
            .map_err(refuse)?;
        if tree.mint != mint
            || tree.epoch != claim.epoch
            || claim.root == [0; 32]
            || !tree.roots.contains(&claim.root)
        {
            return Err(refuse(bad("a root is not one of the tree's")));
        }
    }
    if verify {
        rewards.verified.fetch_add(1, Ordering::Relaxed);
        verify_natively(state, request, &key)?;
    }
    let creates_ata = accounts[4].is_none();
    let claims = request.claims.len() as u64;
    let cost = claim_cost_lamports(
        &rewards.pinned,
        claims,
        creates_ata,
        &rewards.rents(state).await?,
    );
    if cost > MAX_LAMPORTS_PER_TX || !repaid(cost, claims, reward.claim_fee, rate) {
        return Err(refuse(Problem::Fee));
    }
    let tokens = TOKEN_PROGRAM;
    let mut remaining = Vec::new();
    for (i, claim) in request.claims.iter().enumerate() {
        remaining.push(AccountMeta::new_readonly(keys[5 + i * 2], false));
        remaining.push(AccountMeta::new(
            nullifier_address(state, &claim.nullifier_hash),
            false,
        ));
    }
    let mut builder = ClaimRewardsBuilder::new();
    builder
        .payer(state.fee_payer.pubkey())
        .reward_config(config_key)
        .reward_mint(reward_key)
        .pool_ledger(program.find_ledger_pda(&reward_key).0)
        .pool_escrow(program.find_escrow_pda(&reward_key).0)
        .fee_account(reward.fee_account)
        .recipient(recipient_token)
        .mint(mint)
        .token_program(tokens)
        .system_program(Pubkey::default())
        .vk_sha256(request.vk_sha256)
        .max_fee(request.max_fee)
        .claims(
            request
                .claims
                .iter()
                .map(|c| WireClaim {
                    epoch: c.epoch,
                    root: c.root,
                    nullifier_hash: c.nullifier_hash,
                    exp: c.exp,
                    proof: c.proof,
                })
                .collect(),
        )
        .add_remaining_accounts(&remaining);
    let mut instructions = Vec::new();
    if creates_ata {
        instructions.push(create_associated_idempotent(
            &state.fee_payer.pubkey(),
            &request.recipient,
            &mint,
        ));
    }
    instructions.push(program.target(builder.instruction()));
    Ok(PlannedClaim {
        instructions,
        cost_lamports: cost,
    })
}

/// The scope a claim's proof is bound to: this program, mint and cluster.
fn scope(state: &Gateway) -> [u8; 32] {
    let hash = Sha256::new()
        .chain_update(b"buckspay/reward")
        .chain_update(state.settings.program.id())
        .chain_update(state.settings.mint)
        .chain_update(state.settings.genesis_hash)
        .finalize();
    fr::reduce(&hash.into())
}

/// Verifies the proofs with the host implementation of the program's verifier.
fn verify_natively(state: &Gateway, request: &ClaimRequest, key: &Vk) -> Result<(), Error> {
    let scope = scope(state);
    let owner = request.recipient.to_bytes();
    let (hi, lo) = (word(&owner[..16]), word(&owner[16..]));
    let max_fee = word(&request.max_fee.to_be_bytes());
    let publics: Vec<ClaimPublic> = request
        .claims
        .iter()
        .map(|claim| {
            let mut public: ClaimPublic = [[0; 32]; CLAIM_NUM_PUBLIC];
            public[..].copy_from_slice(&[
                claim.root,
                claim.nullifier_hash,
                scope,
                hi,
                lo,
                word(&[claim.exp]),
                max_fee,
            ]);
            public
        })
        .collect();
    let proofs: Vec<_> = request.claims.iter().map(|c| c.proof).collect();
    verify_claims_with(key, &proofs, &publics).map_err(|_| refuse(bad("a proof does not verify")))
}

/// What the gateway paid for a sent transaction.
struct Sent {
    signature: Signature,
    compute_units: u64,
}

/// Simulates the transaction, signs it as the fee payer and sends it. The outcome is waited for
/// by the caller. The job holds the signature before the wait, so that a restart looks it up
/// instead of sending again.
async fn submit(
    state: &Gateway,
    key: &str,
    mut transaction: VersionedTransaction,
    last_valid: u64,
) -> Result<Sent, Error> {
    let simulation = state
        .rpc
        .simulate_transaction_with_config(
            &transaction,
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
        warn!(%failure, "a reward transaction would fail");
        return Err(match TransactionError::from(failure) {
            TransactionError::InstructionError(..) => refuse(bad("rejected")),
            _ => Error::Retry,
        });
    }
    let signature = state
        .fee_payer
        .sign_message(&transaction.message.serialize());
    transaction.signatures[0] = signature;
    let text = signature.to_string();
    state
        .rewards
        .jobs
        .update(key, |job| {
            job.signature = Some(text);
            job.last_valid_block_height = Some(last_valid);
        })
        .map_err(|_| Error::Upstream)?;
    state
        .rpc
        .send_transaction(&transaction)
        .await
        .map_err(|error| {
            if error.get_transaction_error().is_some() {
                refuse(bad("rejected"))
            } else {
                Error::Upstream
            }
        })?;
    Ok(Sent {
        signature,
        compute_units: simulation.units_consumed.unwrap_or(0),
    })
}

async fn claim_transaction(
    state: &Gateway,
    plan: &PlannedClaim,
) -> Result<(VersionedTransaction, u64), Error> {
    let pinned = &state.rewards.pinned;
    let (blockhash, last_valid) = state
        .rpc
        .get_latest_blockhash_with_commitment(state.rpc.commitment())
        .await
        .map_err(unreachable)?;
    let loaded = loaded_accounts_limit(loaded_accounts_size(state, &plan.instructions).await?);
    let message = compose(
        state,
        &plan.instructions,
        blockhash,
        pinned.claim_cu,
        loaded,
        pinned.priority_fee(pinned.claim_cu),
    )?;
    Ok((
        VersionedTransaction {
            signatures: vec![Signature::default()],
            message,
        },
        last_valid,
    ))
}

/// Looks at what became of a transaction the job sent: landed, failed, or not yet known and
/// still able to land.
async fn lookup(state: &Gateway, job: &RewardJob) -> Option<Outcome> {
    let signature: Signature = job.signature.as_ref()?.parse().ok()?;
    let statuses = state.rpc.get_signature_statuses(&[signature]).await.ok()?;
    if let Some(Some(status)) = statuses.value.first() {
        return Some(if status.err.is_some() {
            Outcome::FailedOnChain
        } else {
            Outcome::Landed
        });
    }
    let gone = match (job.kind, job.last_valid_block_height) {
        (Kind::Claim, Some(last_valid)) => state.rpc.get_block_height().await.ok()? > last_valid,
        _ => local_now().saturating_sub(job.created_at) > 2 * SWEEP_TTL,
    };
    gone.then_some(Outcome::FailedOnChain)
}

fn end(state: &Gateway, key: &str, outcome: JobState) {
    if let Err(error) = state.rewards.jobs.update(key, |job| job.state = outcome) {
        warn!(%error, "a reward job could not be written");
    }
}

fn settle(state: &Gateway, key: &str, sent: Option<&Sent>) {
    let _ = state.rewards.jobs.update(key, |job| {
        job.state = JobState::Settled;
        if let Some(sent) = sent {
            job.signature = Some(sent.signature.to_string());
            job.compute_units = Some(sent.compute_units);
        }
    });
}

/// Sends a job from what the chain says now and ends it by its outcome. What `ended` does not end
/// for good is left pending for the janitor: a retry never ends a job.
pub(crate) async fn drive(state: &Gateway, key: &str) {
    let Some(_driving) = state.rewards.drive(key) else {
        return;
    };
    let Some(job) = state.rewards.jobs.get(key) else {
        return;
    };
    if job.state != JobState::Pending {
        return;
    }
    if job.signature.is_some() {
        match lookup(state, &job).await {
            Some(Outcome::Landed) => return settle(state, key, None),
            Some(Outcome::FailedOnChain) => {
                let _ = state.rewards.jobs.update(key, |job| job.signature = None);
            }
            _ => return,
        }
    }
    let result = match job.kind {
        Kind::Claim => drive_claim(state, key, &job).await,
        Kind::Sweep => drive_sweep(state, key, &job).await,
    };
    match result {
        Ok(sent) => match confirm(state, &sent.signature).await {
            Outcome::Landed => {
                info!(units = sent.compute_units, "a reward job settled");
                settle(state, key, Some(&sent));
            }
            Outcome::FailedOnChain => end(state, key, JobState::Failed("failed".into())),
            Outcome::Unknown => warn!("a reward job waits for the janitor"),
        },
        Err(error) if ended(&error).is_some() => {
            end(state, key, JobState::Failed(reason_of(&error).into()));
        }
        Err(_) => warn!("a reward job waits for the janitor"),
    }
}

fn reason_of(error: &Error) -> &'static str {
    match error {
        Error::Settlement(Problem::Spent) => "spent",
        Error::Settlement(Problem::Fee) => "fee",
        Error::Settlement(Problem::StaleKey) => "stale_key",
        Error::Settlement(Problem::Window(_)) => "window",
        _ => "invalid",
    }
}

fn reason_text(reason: &FinalReason) -> &'static str {
    match reason {
        FinalReason::Invalid => "invalid",
        FinalReason::Window => "window",
        FinalReason::Conflict => "conflict",
        FinalReason::Lock => "lock",
        FinalReason::StaleKey => "stale_key",
        FinalReason::BelowFee => "below_fee",
        FinalReason::Spent => "spent",
        FinalReason::Fee => "fee",
    }
}

async fn drive_claim(state: &Gateway, key: &str, job: &RewardJob) -> Result<Sent, Error> {
    let request = parse_claim(job.body.as_bytes()).map_err(refuse)?;
    let plan = plan_claim(state, &request, false).await?;
    let (transaction, last_valid) = claim_transaction(state, &plan).await?;
    submit(state, key, transaction, last_valid).await
}

fn sweep_transaction(body: &str) -> Result<VersionedTransaction, Problem> {
    let bytes = BASE64_STANDARD
        .decode(body)
        .map_err(|_| bad("the transaction is not base64"))?;
    if bytes.len() > MAX_TRANSACTION_BYTES {
        return Err(bad("the transaction is too large"));
    }
    bincode::deserialize(&bytes).map_err(|_| bad("the transaction does not decode"))
}

/// Whether the fresh address signed this message: the gateway never pays for a sweep nobody
/// authorised.
fn signed_by_fresh(tx: &VersionedTransaction, fresh: &Pubkey) -> bool {
    tx.signatures[1].verify(fresh.as_ref(), &tx.message.serialize())
}

async fn drive_sweep(state: &Gateway, key: &str, job: &RewardJob) -> Result<Sent, Error> {
    if local_now().saturating_sub(job.created_at) > SWEEP_TTL {
        return Err(refuse(Problem::Window("expired")));
    }
    let tx = sweep_transaction(&job.body).map_err(refuse)?;
    let cfg = read_sweep_config(state).await?;
    let plan = check_sweep(&tx, &cfg).map_err(refuse)?;
    if !signed_by_fresh(&tx, &plan.fresh) {
        return Err(refuse(bad("the fresh address did not sign")));
    }
    submit(state, key, tx, 0).await
}

async fn read_sweep_config(state: &Gateway) -> Result<SweepConfig, Error> {
    let rewards = &state.rewards;
    let rate = rewards.rate.ok_or(refuse(Problem::Paused))?;
    let fee_account = state.settings.fee_token.ok_or(refuse(Problem::Paused))?;
    let mint = read(state, &[state.settings.mint])
        .await?
        .remove(0)
        .filter(|mint| mint.owner == TOKEN_PROGRAM && mint.data.len() > 44)
        .ok_or(refuse(Problem::Paused))?;
    Ok(SweepConfig::new(
        rewards.pinned,
        state.fee_payer.pubkey(),
        (state.settings.mint, mint.data[44]),
        fee_account,
        rate,
        &rewards.rents(state).await?,
    ))
}

fn answer_json(answer: &Answer, key: Option<&str>) -> Json<Value> {
    let mut body = answer.body();
    if let (Some(key), Some(body)) = (key, body.as_object_mut()) {
        body.insert("jobKey".into(), json!(key));
    }
    Json(body)
}

fn code_of(answer: &Answer) -> String {
    match answer {
        Answer::Submitted => "submitted".into(),
        Answer::Settled { .. } => "settled".into(),
        Answer::Duplicate => "duplicate".into(),
        Answer::Retry { .. } => "retry".into(),
        Answer::Refused { reason } => reason_text(reason).into(),
    }
}

/// Logs how a reward request ended, with only its code, status, a short id that cannot be
/// reversed and the time it took.
fn answered(
    route: &str,
    id: &str,
    started: Instant,
    answer: &Answer,
    key: Option<&str>,
) -> Json<Value> {
    info!(
        route,
        id,
        status = 200,
        code = code_of(answer),
        elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        "reward request answered"
    );
    answer_json(answer, key)
}

fn failed(error: Error) -> Answer {
    answer_for(&Err::<Planned, _>(error))
}

fn tomorrow(now: u32) -> u64 {
    u64::from(SECONDS_PER_DAY - now % SECONDS_PER_DAY)
}

/// Whether `cost` fits in what is left of the day's budget.
fn within_budget(state: &Gateway, cost: u64, now: u32) -> Result<(), Error> {
    let committed = state.rewards.jobs.committed_on(now / SECONDS_PER_DAY);
    match committed.checked_add(cost) {
        Some(total) if total <= state.rewards.daily_budget => Ok(()),
        _ => Err(refuse(Problem::CapExhausted(
            u32::try_from(tomorrow(now)).unwrap_or(SECONDS_PER_DAY),
        ))),
    }
}

pub(crate) async fn post_claims(
    State(state): State<Arc<Gateway>>,
    Extension(Client(ip)): Extension<Client>,
    body: Bytes,
) -> Json<Value> {
    let started = Instant::now();
    if !state.rewards.admit_claim(Prefix::from(ip)) {
        let answer = Answer::Retry {
            retry_after: RETRY_AFTER,
        };
        return answered("claims", "00000000", started, &answer, None);
    }
    let request = match parse_claim(&body) {
        Ok(request) => request,
        Err(problem) => {
            let id = hex::encode(&Sha256::digest(&body)[..4]);
            return answered("claims", &id, started, &failed(refuse(problem)), None);
        }
    };
    let key = hex::encode(claim_job_key(&request.nullifiers()));
    let id = key[..8].to_owned();
    if state
        .rewards
        .jobs
        .get(&key)
        .is_some_and(|job| !matches!(job.state, JobState::Failed(_)))
    {
        return answered("claims", &id, started, &Answer::Duplicate, Some(&key));
    }
    let now = local_now();
    let planned = match plan_claim(&state, &request, true).await {
        Ok(planned) => planned,
        Err(error) => return answered("claims", &id, started, &failed(error), None),
    };
    if let Err(error) = within_budget(&state, planned.cost_lamports, now) {
        return answered("claims", &id, started, &failed(error), None);
    }
    let job = RewardJob {
        key: key.clone(),
        kind: Kind::Claim,
        created_at: now,
        state: JobState::Pending,
        cost_lamports: planned.cost_lamports,
        body: String::from_utf8_lossy(&body).into_owned(),
        fresh: None,
        signature: None,
        last_valid_block_height: None,
        compute_units: None,
    };
    let answer = begin(&state, job);
    answered("claims", &id, started, &answer, Some(&key))
}

/// Writes a job down and starts sending it, and answers `submitted` only then.
fn begin(state: &Arc<Gateway>, job: RewardJob) -> Answer {
    let key = job.key.clone();
    match state.rewards.jobs.begin(job) {
        Ok(true) => {
            let driven = Arc::clone(state);
            tokio::spawn(async move { drive(&driven, &key).await });
            Answer::Submitted
        }
        Ok(false) => Answer::Duplicate,
        Err(_) => {
            warn!("a reward job could not be written; nothing was sent");
            Answer::Retry {
                retry_after: RETRY_AFTER,
            }
        }
    }
}

#[derive(Deserialize)]
pub struct SweepBody {
    pub transaction: String,
}

pub(crate) async fn post_sweeps(
    State(state): State<Arc<Gateway>>,
    Extension(Client(ip)): Extension<Client>,
    body: Bytes,
) -> Json<Value> {
    let started = Instant::now();
    if state.rewards.sweep_ip.check(Prefix::from(ip)).is_err() {
        let answer = Answer::Retry {
            retry_after: RETRY_AFTER,
        };
        return answered("sweeps", "00000000", started, &answer, None);
    }
    let id = hex::encode(&Sha256::digest(&body)[..4]);
    let Ok(SweepBody { transaction }) = serde_json::from_slice(&body) else {
        return answered(
            "sweeps",
            &id,
            started,
            &failed(refuse(bad("not a sweep"))),
            None,
        );
    };
    let result = prepare_sweep(&state, &transaction).await;
    match result {
        Ok((job, duplicate)) => {
            let key = job.key.clone();
            let answer = if duplicate {
                Answer::Duplicate
            } else {
                begin(&state, job)
            };
            answered("sweeps", &key[..8], started, &answer, Some(&key))
        }
        Err(error) => answered("sweeps", &id, started, &failed(error), None),
    }
}

/// Everything about a sweep that is checked before the gateway signs or simulates anything.
async fn prepare_sweep(state: &Gateway, transaction: &str) -> Result<(RewardJob, bool), Error> {
    let tx = sweep_transaction(transaction).map_err(refuse)?;
    let cfg = read_sweep_config(state).await?;
    let plan = check_sweep(&tx, &cfg).map_err(refuse)?;
    if !signed_by_fresh(&tx, &plan.fresh) {
        return Err(refuse(bad("the fresh address did not sign")));
    }
    let key = hex::encode(Sha256::digest(
        [b"sweep".as_slice(), &tx.message.serialize()].concat(),
    ));
    if state
        .rewards
        .jobs
        .get(&key)
        .is_some_and(|job| !matches!(job.state, JobState::Failed(_)))
    {
        return Ok((placeholder(key), true));
    }
    if state.rewards.jobs.sweeping(&plan.fresh) {
        return Err(Error::Busy);
    }
    let rewards = &state.rewards;
    let cost = sweep_cost_lamports(
        &rewards.pinned,
        plan.creates_ata,
        &rewards.rents(state).await?,
    );
    let now = local_now();
    within_budget(state, cost, now)?;
    Ok((
        RewardJob {
            key,
            kind: Kind::Sweep,
            created_at: now,
            state: JobState::Pending,
            cost_lamports: cost,
            body: transaction.to_owned(),
            fresh: Some(plan.fresh.to_string()),
            signature: None,
            last_valid_block_height: None,
            compute_units: None,
        },
        false,
    ))
}

fn placeholder(key: String) -> RewardJob {
    RewardJob {
        key,
        kind: Kind::Sweep,
        created_at: 0,
        state: JobState::Pending,
        cost_lamports: 0,
        body: String::new(),
        fresh: None,
        signature: None,
        last_valid_block_height: None,
        compute_units: None,
    }
}

/// `GET /v1/claims/{jobKey}`: the status of a claim or a sweep.
pub(crate) async fn status(
    State(state): State<Arc<Gateway>>,
    Path(key): Path<String>,
) -> Result<Json<Value>, Error> {
    let job = state.rewards.jobs.get(&key).ok_or(Error::Gone)?;
    let answer = match &job.state {
        JobState::Pending => Answer::Submitted,
        JobState::Settled => Answer::Settled {
            signature: job.signature.clone().unwrap_or_default(),
        },
        JobState::Failed(reason) => Answer::Refused {
            reason: match reason.as_str() {
                "spent" => FinalReason::Spent,
                "fee" => FinalReason::Fee,
                "stale_key" => FinalReason::StaleKey,
                "window" => FinalReason::Window,
                _ => FinalReason::Invalid,
            },
        },
    };
    let mut body = answer.body();
    if let (JobState::Settled, Some(units), Some(body)) =
        (&job.state, job.compute_units, body.as_object_mut())
    {
        body.insert("computeUnits".into(), json!(units));
    }
    Ok(Json(body))
}

/// The janitor's part: jobs that were written and not finished are sent again, a sweep whose
/// blockhash is gone is ended, and what has outlived its window is forgotten.
pub(crate) async fn resume_pending(state: &Gateway) {
    for job in state.rewards.jobs.pending() {
        drive(state, &job.key).await;
    }
}

/// Refuses to start a gateway whose on-chain `claim_fee` does not repay a claim at the admin's
/// rate. A chain with no reward pool configured is not an error: the endpoints answer `retry`.
pub async fn check_economics(state: &Gateway) -> Result<(), String> {
    let Some(rate) = state.rewards.rate else {
        return Ok(());
    };
    let address = address(state, &[b"reward-mint", state.settings.mint.as_ref()]);
    let Some(account) = state
        .rpc
        .get_account_with_commitment(&address, state.rpc.commitment())
        .await
        .map_err(|e| e.to_string())?
        .value
    else {
        return Ok(());
    };
    let reward = RewardMint::from_bytes(&account.data).map_err(|e| e.to_string())?;
    let rents = state
        .rewards
        .rents(state)
        .await
        .map_err(|_| "Solana is unreachable")?;
    economics(
        &state.rewards.pinned,
        &rents,
        rate,
        reward.claim_fee,
        reward.unit,
    )
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use solana_hash::Hash;
    use solana_message::v0;

    pub const RENTS: ClaimRents = ClaimRents {
        nullifier: 650_240,
        token_account: 1_488_440,
    };

    pub fn pinned() -> Pinned {
        Pinned {
            claim_cu: 400_000,
            sweep_cu: 20_000,
            priority_price: 10_000,
        }
    }

    pub fn rate() -> Rate {
        Rate::per_sol(150_000_000)
    }

    fn b64(bytes: &[u8]) -> String {
        BASE64_STANDARD.encode(bytes)
    }

    pub fn claim_body_with_proof_len(len: usize) -> Vec<u8> {
        let mut body = claim_body(1);
        let mut parsed: ClaimBody = serde_json::from_slice(&body).unwrap();
        parsed.claims[0].proof = b64(&vec![7; len]);
        body.clear();
        serde_json::to_writer(&mut body, &parsed).unwrap();
        body
    }

    pub fn claim_body(n: usize) -> Vec<u8> {
        let claims = (0..n as u8)
            .map(|i| ClaimEntry {
                epoch: 0,
                root: b64(&word(&[9 + i])),
                nullifier_hash: b64(&word(&[1 + i])),
                exp: 1 + i % 7,
                proof: b64(&[i; CLAIM_PROOF_COMPRESSED]),
            })
            .collect();
        serde_json::to_vec(&ClaimBody {
            vk_sha256: b64(&[5; 32]),
            recipient: Pubkey::new_from_array([4; 32]).to_string(),
            max_fee: 900_000,
            claims,
        })
        .unwrap()
    }

    pub fn claim_request(n: usize) -> ClaimRequest {
        parse_claim(&claim_body(n)).unwrap()
    }

    pub fn sweep_config() -> SweepConfig {
        SweepConfig::new(
            pinned(),
            Pubkey::new_from_array([1; 32]),
            (Pubkey::new_from_array([2; 32]), 6),
            Pubkey::new_from_array([3; 32]),
            rate(),
            &RENTS,
        )
    }

    pub fn fresh() -> Pubkey {
        Pubkey::new_from_array([6; 32])
    }

    pub fn transfer(
        program: Pubkey,
        accounts: [Pubkey; 4],
        amount: u64,
        decimals: u8,
    ) -> Instruction {
        let [source, mint, destination, authority] = accounts;
        let mut data = vec![TRANSFER_CHECKED];
        data.extend_from_slice(&amount.to_le_bytes());
        data.push(decimals);
        Instruction {
            program_id: program,
            accounts: vec![
                AccountMeta::new(source, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new(destination, false),
                AccountMeta::new_readonly(authority, true),
            ],
            data,
        }
    }

    /// The sweep the gateway accepts: the pinned compute budget, the destination's token account
    /// created when `creates`, the amount, and the fee.
    pub fn good(cfg: &SweepConfig, creates: bool) -> Vec<Instruction> {
        let owner = Pubkey::new_from_array([8; 32]);
        let (source, destination) = (
            associated(&fresh(), &cfg.mint),
            associated(&owner, &cfg.mint),
        );
        let mut ixs = vec![
            ComputeBudgetInstruction::set_compute_unit_limit(cfg.pinned.sweep_cu),
            ComputeBudgetInstruction::set_compute_unit_price(cfg.pinned.priority_price),
        ];
        if creates {
            ixs.push(create_associated_idempotent(
                &cfg.gateway,
                &owner,
                &cfg.mint,
            ));
        }
        let fee = if creates {
            cfg.sweep_fee_with_ata
        } else {
            cfg.sweep_fee
        };
        let accounts = |to| [source, cfg.mint, to, fresh()];
        ixs.push(transfer(
            TOKEN_PROGRAM,
            accounts(destination),
            1_000_000,
            cfg.decimals,
        ));
        ixs.push(transfer(
            TOKEN_PROGRAM,
            accounts(cfg.fee_account),
            fee,
            cfg.decimals,
        ));
        ixs
    }

    pub fn tx_of(payer: &Pubkey, ixs: &[Instruction]) -> VersionedTransaction {
        let message = v0::Message::try_compile(payer, ixs, &[], Hash::default()).unwrap();
        VersionedTransaction {
            signatures: vec![
                Signature::default();
                usize::from(message.header.num_required_signatures)
            ],
            message: VersionedMessage::V0(message),
        }
    }

    pub fn sweep_tx(cfg: &SweepConfig) -> VersionedTransaction {
        tx_of(&cfg.gateway, &good(cfg, false))
    }
}

#[cfg(test)]
mod tests {
    use super::{testing::*, *};
    use proptest::prelude::*;

    #[test]
    fn job_key_ignores_order_and_proof_bytes() {
        let a = claim_request(3);
        let mut b = a.clone();
        b.claims.reverse();
        b.claims[0].proof[5] ^= 1;
        assert_eq!(
            claim_job_key(&a.nullifiers()),
            claim_job_key(&b.nullifiers())
        );
    }

    #[test]
    fn too_many_or_zero_claims_and_wrong_sizes_are_refused() {
        assert!(parse_claim(&claim_body(0)).is_err());
        assert!(parse_claim(&claim_body(MAX_CLAIMS_PER_TX + 1)).is_err());
        assert!(parse_claim(&claim_body_with_proof_len(127)).is_err());
        assert!(parse_claim(&claim_body_with_proof_len(129)).is_err());
        assert!(parse_claim(&claim_body(MAX_CLAIMS_PER_TX)).is_ok());
    }

    #[test]
    fn a_repeated_nullifier_or_an_out_of_range_leaf_is_refused() {
        let mut body: ClaimBody = serde_json::from_slice(&claim_body(2)).unwrap();
        body.claims[1].nullifier_hash = body.claims[0].nullifier_hash.clone();
        assert!(parse_claim(&serde_json::to_vec(&body).unwrap()).is_err());
        let mut body: ClaimBody = serde_json::from_slice(&claim_body(1)).unwrap();
        for exp in [0, 8] {
            body.claims[0].exp = exp;
            assert!(parse_claim(&serde_json::to_vec(&body).unwrap()).is_err());
        }
        body.claims[0].exp = 1;
        body.claims[0].root = BASE64_STANDARD.encode([0xff; 32]);
        assert!(parse_claim(&serde_json::to_vec(&body).unwrap()).is_err());
    }

    #[test]
    fn repaid_is_false_when_cost_exceeds_fees_at_the_rate() {
        let rate = Rate::usdc_micro_per_lamport(1, 10);
        assert!(repaid(30_000, 1, 3_000, rate));
        assert!(!repaid(30_001, 1, 3_000, rate));
        assert!(repaid(60_000, 2, 3_000, rate));
    }

    #[test]
    fn claim_cost_counts_the_pinned_priority_fee() {
        let p = pinned();
        assert_eq!(
            claim_cost_lamports(&p, 1, true, &RENTS),
            5_000 + 4_000 + 1_488_440 + 650_240
        );
        assert_eq!(
            claim_cost_lamports(&p, 2, false, &RENTS),
            5_000 + 4_000 + 2 * 650_240
        );
        assert_eq!(sweep_cost_lamports(&p, false, &RENTS), 10_000 + 200);
    }

    #[test]
    fn the_claim_fee_lives_between_the_cost_and_the_smallest_leaf() {
        let (p, rate, unit) = (pinned(), rate(), 490_000);
        assert_eq!(
            rate.lamports_to_usdc(claim_cost_lamports(&p, 1, true, &RENTS)),
            322_152
        );
        assert!(economics(&p, &RENTS, rate, 322_152, unit).is_ok());
        assert!(economics(&p, &RENTS, rate, 450_000, unit).is_ok());
        let below = economics(&p, &RENTS, rate, 322_151, unit).unwrap_err();
        assert!(below.contains("claim_fee"), "{below}");
        assert!(economics(&p, &RENTS, rate, 2 * unit, unit).is_err());
        assert!(economics(&p, &RENTS, Rate::per_sol(400_000_000), 450_000, unit).is_err());
    }

    #[test]
    fn sweep_accepts_exactly_the_two_transfers_and_nothing_else() {
        let cfg = sweep_config();
        let plan = check_sweep(&sweep_tx(&cfg), &cfg).unwrap();
        assert_eq!(
            (plan.fresh, plan.creates_ata, plan.fee),
            (fresh(), false, cfg.sweep_fee)
        );
        let other = Pubkey::new_unique();
        let case = |change: &dyn Fn(&mut Vec<Instruction>)| {
            let mut ixs = good(&cfg, false);
            change(&mut ixs);
            tx_of(&cfg.gateway, &ixs)
        };
        let source = associated(&fresh(), &cfg.mint);
        let last = good(&cfg, false).len() - 1;
        let cases: Vec<(&str, VersionedTransaction)> = vec![
            (
                "extra instruction",
                case(&|ixs| ixs.push(Instruction::new_with_bytes(other, &[1], vec![]))),
            ),
            (
                "fee too low",
                case(&|ixs| {
                    ixs[last] = transfer(
                        TOKEN_PROGRAM,
                        [source, cfg.mint, cfg.fee_account, fresh()],
                        cfg.sweep_fee - 1,
                        cfg.decimals,
                    )
                }),
            ),
            (
                "fee to another account",
                case(&|ixs| {
                    ixs[last] = transfer(
                        TOKEN_PROGRAM,
                        [source, cfg.mint, other, fresh()],
                        cfg.sweep_fee,
                        cfg.decimals,
                    )
                }),
            ),
            (
                "gateway writable",
                case(&|ixs| {
                    ixs[last - 1] = transfer(
                        TOKEN_PROGRAM,
                        [source, cfg.mint, cfg.gateway, fresh()],
                        1,
                        cfg.decimals,
                    )
                }),
            ),
            (
                "gateway as transfer authority",
                case(&|ixs| {
                    ixs[last] = transfer(
                        TOKEN_PROGRAM,
                        [source, cfg.mint, cfg.fee_account, cfg.gateway],
                        cfg.sweep_fee,
                        cfg.decimals,
                    )
                }),
            ),
            (
                "destination is the source",
                case(&|ixs| {
                    ixs[last - 1] = transfer(
                        TOKEN_PROGRAM,
                        [source, cfg.mint, source, fresh()],
                        1,
                        cfg.decimals,
                    )
                }),
            ),
            (
                "other mint",
                case(&|ixs| {
                    ixs[last] = transfer(
                        TOKEN_PROGRAM,
                        [source, other, cfg.fee_account, fresh()],
                        cfg.sweep_fee,
                        cfg.decimals,
                    )
                }),
            ),
            (
                "other source",
                case(&|ixs| {
                    ixs[last] = transfer(
                        TOKEN_PROGRAM,
                        [other, cfg.mint, cfg.fee_account, fresh()],
                        cfg.sweep_fee,
                        cfg.decimals,
                    )
                }),
            ),
            (
                "other decimals",
                case(&|ixs| {
                    ixs[last] = transfer(
                        TOKEN_PROGRAM,
                        [source, cfg.mint, cfg.fee_account, fresh()],
                        cfg.sweep_fee,
                        9,
                    )
                }),
            ),
            (
                "close account",
                case(&|ixs| {
                    ixs[last] = Instruction {
                        program_id: TOKEN_PROGRAM,
                        accounts: vec![
                            AccountMeta::new(source, false),
                            AccountMeta::new(other, false),
                            AccountMeta::new_readonly(fresh(), true),
                        ],
                        data: vec![9],
                    }
                }),
            ),
            (
                "user compute price",
                case(&|ixs| {
                    ixs[1] = ComputeBudgetInstruction::set_compute_unit_price(
                        cfg.pinned.priority_price + 1,
                    )
                }),
            ),
            (
                "user compute limit",
                case(&|ixs| {
                    ixs[0] =
                        ComputeBudgetInstruction::set_compute_unit_limit(cfg.pinned.sweep_cu * 2)
                }),
            ),
            (
                "compute budget missing",
                case(&|ixs| {
                    ixs.remove(0);
                }),
            ),
            (
                "token-2022 program",
                case(&|ixs| {
                    for ix in &mut ixs[2..] {
                        ix.program_id = crate::chain::TOKEN_2022_PROGRAM
                    }
                }),
            ),
            ("other fee payer", tx_of(&other, &good(&cfg, false))),
            (
                "token account of another mint created",
                tx_of(&cfg.gateway, &{
                    let mut ixs = good(&cfg, true);
                    ixs[2] = create_associated_idempotent(&cfg.gateway, &other, &other);
                    ixs
                }),
            ),
            (
                "creation paid by another account",
                tx_of(&cfg.gateway, &{
                    let mut ixs = good(&cfg, true);
                    ixs[2] = create_associated_idempotent(
                        &other,
                        &Pubkey::new_from_array([8; 32]),
                        &cfg.mint,
                    );
                    ixs
                }),
            ),
            (
                "creation without the creation fee",
                tx_of(&cfg.gateway, &{
                    let mut ixs = good(&cfg, true);
                    let at = ixs.len() - 1;
                    ixs[at] = transfer(
                        TOKEN_PROGRAM,
                        [source, cfg.mint, cfg.fee_account, fresh()],
                        cfg.sweep_fee,
                        cfg.decimals,
                    );
                    ixs
                }),
            ),
        ];
        for (name, tx) in cases {
            assert!(check_sweep(&tx, &cfg).is_err(), "{name} accepted");
        }
        let created = check_sweep(&tx_of(&cfg.gateway, &good(&cfg, true)), &cfg).unwrap();
        assert!(created.creates_ata && created.fee == cfg.sweep_fee_with_ata);
    }

    #[test]
    fn the_sweep_instructions_are_the_ones_the_app_builds() {
        let cfg = sweep_config();
        let vector: Value =
            serde_json::from_str(include_str!("../tests/fixtures/sweep_vector.json")).unwrap();
        let key = |bytes: [u8; 32]| Pubkey::new_from_array(bytes).to_string();
        assert_eq!(vector["gateway"], cfg.gateway.to_string());
        assert_eq!(vector["fresh"], fresh().to_string());
        assert_eq!(vector["owner"], key([8; 32]));
        assert_eq!(vector["mint"], cfg.mint.to_string());
        assert_eq!(vector["feeAccount"], cfg.fee_account.to_string());
        assert_eq!(vector["decimals"], cfg.decimals);
        assert_eq!(vector["amount"], "1000000");
        assert_eq!(vector["fee"], cfg.sweep_fee_with_ata.to_string());
        assert_eq!(vector["computeUnitLimit"], cfg.pinned.sweep_cu);
        assert_eq!(vector["computeUnitPrice"], cfg.pinned.priority_price);
        let ixs = good(&cfg, true);
        let listed: Vec<Value> = ixs
            .iter()
            .map(|ix| {
                json!({
                    "program": ix.program_id.to_string(),
                    "accounts": ix.accounts.iter().map(|meta| json!({
                        "address": meta.pubkey.to_string(),
                        "signer": meta.is_signer,
                        "writable": meta.is_writable,
                    })).collect::<Vec<_>>(),
                    "data": hex::encode(&ix.data),
                })
            })
            .collect();
        assert_eq!(Value::Array(listed), vector["instructions"]);
        check_sweep(&tx_of(&cfg.gateway, &ixs), &cfg).unwrap();
    }

    proptest! {
        #[test]
        fn the_job_key_is_the_same_for_any_order_of_the_same_nullifiers(
            mut nullifiers in proptest::collection::vec(any::<[u8; 32]>(), 1..5),
            shift in 0usize..4,
        ) {
            let key = claim_job_key(&nullifiers);
            let len = nullifiers.len();
            nullifiers.rotate_left(shift % len);
            prop_assert_eq!(key, claim_job_key(&nullifiers));
        }

        #[test]
        fn repaid_is_exactly_the_cost_in_mint_units_within_the_fees(
            cost in 0u64..u64::MAX / 2,
            claims in 1u64..=4,
            fee in 0u64..u64::MAX / 8,
            num in 1u64..1_000_000,
            den in 1u64..1_000_000_000,
        ) {
            let rate = Rate::usdc_micro_per_lamport(num, den);
            let covered = rate.lamports_to_usdc(cost) <= claims * fee;
            prop_assert_eq!(repaid(cost, claims, fee, rate), covered);
        }

        #[test]
        fn a_claim_never_costs_less_with_more_leaves_and_never_overflows(
            claims in 0u64..u64::MAX,
            ata in any::<bool>(),
            nullifier in any::<u64>(),
            token_account in any::<u64>(),
            price in any::<u64>(),
        ) {
            let p = Pinned { claim_cu: 400_000, sweep_cu: 20_000, priority_price: price };
            let rents = ClaimRents { nullifier, token_account };
            let one = claim_cost_lamports(&p, claims, ata, &rents);
            prop_assert!(claim_cost_lamports(&p, claims.saturating_add(1), ata, &rents) >= one);
            prop_assert!(one >= SIGNATURE_FEE);
        }

        #[test]
        fn a_sweep_fee_below_the_minimum_is_never_accepted(fee in 1u64..1_530) {
            let cfg = sweep_config();
            let source = associated(&fresh(), &cfg.mint);
            let mut ixs = good(&cfg, false);
            let last = ixs.len() - 1;
            ixs[last] = transfer(TOKEN_PROGRAM, [source, cfg.mint, cfg.fee_account, fresh()], fee, cfg.decimals);
            prop_assert!(check_sweep(&tx_of(&cfg.gateway, &ixs), &cfg).is_err());
        }
    }
}
