//! Sponsored records of circular nettings. A netting is recorded by anyone who holds the statement, the
//! signature of every participant and the proof: the gateway checks all of it with the crates the
//! program uses before it spends anything, and the program checks it again. Two lanes pay for the
//! record: a free one, bounded by a daily cap and by the network a request comes from, and a paid
//! one, whose payment covers the fee and the rent in advance. A cap slot or a payment is written
//! down before the send and is never given back, whatever the outcome.
use crate::{
    chain::{CLOCK_SYSVAR, SIGNATURE_FEE},
    fees::priority_fee,
    jobs::write_atomic,
    onboard::{chain_now, read},
    server::{Client, Error, Gateway},
    settlements::{compose, loaded_accounts_limit, loaded_accounts_size},
    sponsored::{Outcome, confirm, hex_array, unreachable},
    transactions,
    zk::keys_body,
};
use axum::{
    Extension, Json,
    body::Bytes,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use buckspay_client::{Program, accounts::Netting, types::KeyHashes};
use buckspay_protocol::{
    hash::{domain, purpose},
    netting::{MAX_PARTICIPANTS, NettingStatement},
    profile::SHORT_PROGRAM_ID,
    record,
};
use buckspay_zk_verify::{NETTING_PROOF_RAW, verify_netting_raw_with, vk};
use ed25519_dalek::{Signature as DalekSignature, VerifyingKey};
use governor::{DefaultKeyedRateLimiter, Quota, RateLimiter};
use serde::{Deserialize, Serialize};
use serde_json::json;
use solana_account::Account;
use solana_instruction::Instruction;
use solana_pubkey::Pubkey;
use solana_rpc_client_api::config::{RpcSimulateTransactionConfig, RpcTransactionConfig};
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction_status_client_types::UiTransactionEncoding;
use std::{
    collections::BTreeMap,
    io,
    net::IpAddr,
    num::NonZeroU32,
    path::PathBuf,
    str::FromStr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tracing::{info, warn};

pub use buckspay_client::accounts::NETTING_DISCRIMINATOR;

/// Seconds before a statement expires from which the gateway no longer sends its record: a
/// transaction that lands after `expires` is a fee wasted.
pub const SEND_MARGIN: u32 = 60;
/// A request is a few hundred bytes of hex; anything larger is refused before it is read.
pub const BODY_LIMIT: usize = 4096;
/// The compute units a record is given: n = 8 takes 129,563.
pub const COMPUTE_UNIT_LIMIT: u32 = 200_000;
/// A quote is kept this long after it expires, so that a member can pay near its end and still
/// record within the days a statement lasts.
const QUOTE_KEEP: u32 = 4 * 86_400;
const MEMO_PROGRAM: Pubkey = Pubkey::from_str_const("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const ED25519_PROGRAM: Pubkey =
    Pubkey::from_str_const("Ed25519SigVerify111111111111111111111111111");
const SEND_ATTEMPTS: u32 = 8;
const SEND_RETRY_WAIT: Duration = Duration::from_millis(500);

/// The seconds a record outlives the expiry of its statement before anyone can close it: 30 days,
/// and two minutes in the short-windows build.
pub fn keep_secs(program: &Pubkey) -> u32 {
    if program.to_string() == SHORT_PROGRAM_ID {
        120
    } else {
        30 * 86_400
    }
}

/// The network a free-lane request comes from: its /24 for IPv4 and its /48 for IPv6, the block
/// one subscriber is given, so that rotating /64s does not reset the limit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NettingPrefix {
    V4([u8; 3]),
    V6([u8; 6]),
}

pub fn netting_prefix(ip: IpAddr) -> NettingPrefix {
    match ip.to_canonical() {
        IpAddr::V4(v4) => NettingPrefix::V4(v4.octets()[..3].try_into().unwrap()),
        IpAddr::V6(v6) => NettingPrefix::V6(v6.octets()[..6].try_into().unwrap()),
    }
}

/// Whether a record sent now can still land before `expires`.
pub fn within_margin(chain_now: u32, expires: u32) -> bool {
    chain_now.saturating_add(SEND_MARGIN) < expires
}

/// What a quoted record costs the sponsor: the fee and the rent, and a tenth more.
pub fn quote_lamports(fee: u64, rent: u64) -> u64 {
    (fee.saturating_add(rent).saturating_mul(11)).div_ceil(10)
}

/// Whether `account` is the record of a statement that expires at `expires`: owned by the program,
/// 48 bytes, the discriminator of `Netting`, and closable when the program sets it. A system
/// account that was sent lamports at the address is not one.
pub fn is_netting_record(account: &Account, expires: u32, program: &Pubkey) -> bool {
    account.owner == *program
        && account.data.len() == Netting::LEN
        && account.data[..8] == NETTING_DISCRIMINATOR
        && account.data[Netting::LEN - 4..]
            == expires.saturating_add(keep_secs(program)).to_le_bytes()
}

#[derive(Clone, Debug)]
pub struct NettingCaps {
    /// Free-lane records the gateway sponsors in a day of the chain's clock.
    pub daily: u32,
    /// Free-lane requests one network may make in an hour.
    pub ip_hourly: u32,
    /// Seconds a quote of the paid lane lasts.
    pub quote_ttl: u32,
    /// Where the day's count, the quotes and the used payments are kept.
    pub store: PathBuf,
}

impl Default for NettingCaps {
    fn default() -> Self {
        Self {
            daily: 100,
            ip_hourly: 5,
            quote_ttl: 600,
            store: PathBuf::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct Quote {
    lamports: u64,
    expires_at: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct Used {
    content: String,
    at: u32,
}

#[derive(Default, Clone, Serialize, Deserialize)]
struct Store {
    day: u64,
    sent: u32,
    quotes: BTreeMap<String, Quote>,
    payments: BTreeMap<String, Used>,
}

/// Why a cap slot was not given.
#[derive(Debug, PartialEq, Eq)]
pub enum Taken {
    /// The day's slots are used up: seconds until the chain's day turns.
    Capped(u32),
    Unwritable,
}

#[derive(Debug)]
pub enum PaymentError {
    /// The payment was used for another statement.
    UsedForAnother,
    Unwritable(io::Error),
}

/// What bounds the records the gateway pays for.
pub struct Nettings {
    caps: NettingCaps,
    persist: bool,
    ip: DefaultKeyedRateLimiter<NettingPrefix>,
    swept: Mutex<Instant>,
    store: Mutex<Store>,
    verified: AtomicU64,
    keys: Option<KeyHashes>,
}

impl Default for Nettings {
    fn default() -> Self {
        Self::build(NettingCaps::default(), Store::default(), false)
    }
}

fn day_of(now: u32) -> u64 {
    u64::from(now) / 86_400
}

impl Nettings {
    /// The limits with their state in `caps.store`, which survives a restart.
    pub fn open(caps: NettingCaps) -> Result<Self, String> {
        let store = match std::fs::read(&caps.store) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| format!("{} is not a netting store", caps.store.display()))?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Store::default(),
            Err(_) => return Err(format!("{} cannot be read", caps.store.display())),
        };
        Ok(Self::build(caps, store, true))
    }

    fn build(caps: NettingCaps, store: Store, persist: bool) -> Self {
        let quota = NonZeroU32::new(caps.ip_hourly).map_or_else(
            || Quota::per_hour(NonZeroU32::MIN).allow_burst(NonZeroU32::MIN),
            Quota::per_hour,
        );
        let ip = RateLimiter::keyed(quota);
        if caps.ip_hourly == 0 {
            // No free request is allowed: spend the only cell of the quota.
            let _ = ip.check_key(&NettingPrefix::V4([0; 3]));
        }
        Self {
            caps,
            persist,
            ip,
            swept: Mutex::new(Instant::now()),
            store: Mutex::new(store),
            verified: AtomicU64::new(0),
            keys: None,
        }
    }

    /// The netting key files this gateway offers, as the configuration names them.
    pub fn with_keys(mut self, keys: KeyHashes) -> Self {
        self.keys = Some(keys);
        self
    }

    pub fn keys(&self) -> Option<&KeyHashes> {
        self.keys.as_ref()
    }

    pub fn caps(&self) -> &NettingCaps {
        &self.caps
    }

    /// How many requests reached the verification of signatures and proof.
    pub fn verified(&self) -> u64 {
        self.verified.load(Ordering::Relaxed)
    }

    /// Counts a free-lane request from `prefix`; the seconds to wait when the network has used its
    /// hour.
    pub fn admit_ip(&self, prefix: NettingPrefix) -> Result<(), u32> {
        let mut swept = self.swept.lock().unwrap();
        if swept.elapsed() >= Duration::from_secs(60) {
            self.ip.retain_recent();
            *swept = Instant::now();
        }
        drop(swept);
        if self.caps.ip_hourly == 0 {
            return Err(3_600);
        }
        self.ip.check_key(&prefix).map_err(|not_until| {
            use governor::clock::{Clock, DefaultClock};
            let wait = not_until.wait_time_from(DefaultClock::default().now());
            u32::try_from(wait.as_secs().max(1)).unwrap_or(u32::MAX)
        })
    }

    /// Free-lane records sent in the day `now` (the chain's clock) is in.
    pub fn sent_today(&self, now: u32) -> u32 {
        let store = self.store.lock().unwrap();
        if store.day == day_of(now) {
            store.sent
        } else {
            0
        }
    }

    /// Whether the day still has a free slot, without taking it.
    pub fn has_slot(&self, now: u32) -> bool {
        self.sent_today(now) < self.caps.daily
    }

    /// Takes a free-lane slot of the day and writes it down. It is never given back.
    pub fn take(&self, now: u32) -> Result<(), Taken> {
        let mut store = self.store.lock().unwrap();
        let backup = store.clone();
        if store.day != day_of(now) {
            store.day = day_of(now);
            store.sent = 0;
        }
        if store.sent >= self.caps.daily {
            let left = 86_400 - u32::try_from(u64::from(now) % 86_400).unwrap_or(0);
            return Err(Taken::Capped(left));
        }
        store.sent += 1;
        if self.save(&store).is_err() {
            *store = backup;
            return Err(Taken::Unwritable);
        }
        Ok(())
    }

    /// A quote of `lamports` valid for `quote_ttl` seconds from the chain's `now`; the current one
    /// is given again while it has half its life left, so that asking for quotes costs no space.
    pub fn quote(&self, lamports: u64, now: u32) -> Result<(String, u32), io::Error> {
        let mut store = self.store.lock().unwrap();
        let backup = store.clone();
        store
            .quotes
            .retain(|_, q| q.expires_at.saturating_add(QUOTE_KEEP) > now);
        let kept = store.quotes.keys().cloned().collect::<Vec<_>>();
        store.payments.retain(|_, used| {
            used.at
                .saturating_add(self.caps.quote_ttl)
                .saturating_add(QUOTE_KEEP)
                > now
        });
        let current = kept.iter().find(|id| {
            let q = &store.quotes[*id];
            q.lamports == lamports && q.expires_at > now.saturating_add(self.caps.quote_ttl / 2)
        });
        if let Some(id) = current {
            return Ok((id.clone(), store.quotes[id].expires_at));
        }
        let mut raw = [0u8; 8];
        getrandom::fill(&mut raw).map_err(io::Error::other)?;
        let id = hex::encode(raw);
        let expires_at = now.saturating_add(self.caps.quote_ttl);
        store.quotes.insert(
            id.clone(),
            Quote {
                lamports,
                expires_at,
            },
        );
        if let Err(error) = self.save(&store) {
            *store = backup;
            return Err(error);
        }
        Ok((id, expires_at))
    }

    /// The lamports and the last second of a quote this gateway issued and still keeps.
    pub fn issued(&self, id: &str) -> Option<(u64, u32)> {
        let store = self.store.lock().unwrap();
        store.quotes.get(id).map(|q| (q.lamports, q.expires_at))
    }

    /// Whether `signature` may pay for the record of `content`: it has not paid for another.
    pub fn payment_is_free(&self, signature: &str, content: &[u8; 32]) -> bool {
        let store = self.store.lock().unwrap();
        store
            .payments
            .get(signature)
            .is_none_or(|used| used.content == hex::encode(content))
    }

    /// Marks `signature` as used for `content` and writes it down. The same content may use it
    /// again (a send that failed or was lost); no other can, ever.
    pub fn use_payment(&self, signature: &str, content: &[u8; 32]) -> Result<(), PaymentError> {
        let mut store = self.store.lock().unwrap();
        let wanted = hex::encode(content);
        match store.payments.get(signature) {
            Some(used) if used.content != wanted => return Err(PaymentError::UsedForAnother),
            Some(_) => return Ok(()),
            None => {}
        }
        store.payments.insert(
            signature.to_owned(),
            Used {
                content: wanted,
                at: crate::onboard::local_now(),
            },
        );
        if let Err(error) = self.save(&store) {
            store.payments.remove(signature);
            return Err(PaymentError::Unwritable(error));
        }
        Ok(())
    }

    fn save(&self, store: &Store) -> io::Result<()> {
        if self.persist {
            write_atomic(&self.caps.store, store)
        } else {
            Ok(())
        }
    }
}

/// Why a netting is refused with a `400`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Statement,
    Signatures,
    Address,
    Proof,
    Expired,
    Payment,
    Rejected,
}

impl Reason {
    fn as_str(self) -> &'static str {
        match self {
            Reason::Statement => "statement",
            Reason::Signatures => "signatures",
            Reason::Address => "address",
            Reason::Proof => "proof",
            Reason::Expired => "expired",
            Reason::Payment => "payment",
            Reason::Rejected => "rejected",
        }
    }
}

/// A netting that passed every check that needs no read of the chain.
pub struct Checked {
    pub statement: NettingStatement,
    pub content: [u8; 32],
    pub address: Pubkey,
}

/// The program's checks, in the program's order, without the chain: the statement decodes, every
/// participant signed its envelope (strictly), the proof verifies under the netting key and the
/// content has a record address. `verified` counts the calls that reach the verification.
pub fn check(
    verified: &AtomicU64,
    program: &Pubkey,
    genesis: &[u8; 32],
    statement: &[u8],
    signatures: &[[u8; 64]],
    proof: &[u8; NETTING_PROOF_RAW],
) -> Result<Checked, Reason> {
    let statement = NettingStatement::decode(statement).map_err(|_| Reason::Statement)?;
    let n = usize::from(statement.participants);
    if signatures.len() != n {
        return Err(Reason::Signatures);
    }
    verified.fetch_add(1, Ordering::Relaxed);
    let envelope = statement.envelope(&domain(purpose::NETTING, genesis, &program.to_bytes()));
    for (key, signature) in statement.ephemeral[..n].iter().zip(signatures) {
        VerifyingKey::from_bytes(key)
            .and_then(|key| key.verify_strict(&envelope, &DalekSignature::from_bytes(signature)))
            .map_err(|_| Reason::Signatures)?;
    }
    verify_netting_raw_with(&vk::NETTING_VK, &[*proof], &[statement.public_inputs()])
        .map_err(|_| Reason::Proof)?;
    let content = statement.content();
    let address = record::netting_address(&program.to_bytes(), &content)
        .map(Pubkey::new_from_array)
        .ok_or(Reason::Address)?;
    Ok(Checked {
        statement,
        content,
        address,
    })
}

/// The Ed25519 instruction the program accepts, the only layout it does: one entry for each
/// participant, every instruction index `u16::MAX`, then the one message they all signed.
pub fn ed25519_instruction(
    keys: &[[u8; 32]],
    signatures: &[[u8; 64]],
    message: &[u8; 96],
) -> Instruction {
    let n = keys.len();
    let base = 2 + 14 * n;
    let message_offset = base + 96 * n;
    let mut data = vec![u8::try_from(n).unwrap(), 0];
    for i in 0..n {
        let key_offset = base + 96 * i;
        for field in [
            key_offset + 32,
            usize::from(u16::MAX),
            key_offset,
            usize::from(u16::MAX),
            message_offset,
            message.len(),
            usize::from(u16::MAX),
        ] {
            data.extend_from_slice(&u16::try_from(field).unwrap().to_le_bytes());
        }
    }
    for (key, signature) in keys.iter().zip(signatures) {
        data.extend_from_slice(key);
        data.extend_from_slice(signature);
    }
    data.extend_from_slice(message);
    Instruction {
        program_id: ED25519_PROGRAM,
        accounts: vec![],
        data,
    }
}

/// The two instructions that record a netting, paid by `payer`: the participants' signatures and
/// `record_netting`. `netting_domain` is the domain the participants signed under.
pub fn record_instructions(
    program: &Pubkey,
    netting_domain: &[u8; 32],
    payer: &Pubkey,
    statement: &[u8],
    signatures: &[[u8; 64]],
    proof: &[u8; NETTING_PROOF_RAW],
) -> Vec<Instruction> {
    let decoded = NettingStatement::decode(statement).expect("a statement that decodes");
    let n = usize::from(decoded.participants);
    let address = record::netting_address(&program.to_bytes(), &decoded.content())
        .map(Pubkey::new_from_array)
        .expect("a statement with a record address");
    vec![
        ed25519_instruction(
            &decoded.ephemeral[..n],
            signatures,
            &decoded.envelope(netting_domain),
        ),
        transactions::record_netting(&Program::new(*program), payer, &address, statement, proof),
    ]
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NettingBody {
    pub statement: String,
    pub signatures: Vec<String>,
    pub proof: String,
    /// The signature of a transfer to the sponsor with a memo naming the statement: the paid lane.
    #[serde(default)]
    pub payment: Option<String>,
}

/// What a payment to the sponsor carries.
#[derive(Debug, PartialEq, Eq)]
pub struct Payment {
    /// The most any one transfer in it sends to the sponsor.
    pub lamports: u64,
    pub memos: Vec<String>,
}

/// The transfers to `sponsor` and the memos of a transaction. Only instructions of the message
/// itself count, and only accounts it names itself.
pub fn payment_of(transaction: &VersionedTransaction, sponsor: &Pubkey) -> Payment {
    let keys = transaction.message.static_account_keys();
    let mut payment = Payment {
        lamports: 0,
        memos: Vec::new(),
    };
    for instruction in transaction.message.instructions() {
        let Some(program) = keys.get(usize::from(instruction.program_id_index)) else {
            continue;
        };
        if *program == Pubkey::default() {
            let to = instruction
                .accounts
                .get(1)
                .and_then(|i| keys.get(usize::from(*i)));
            if instruction.data.len() == 12
                && instruction.data[..4] == [2, 0, 0, 0]
                && to == Some(sponsor)
            {
                let lamports = u64::from_le_bytes(instruction.data[4..].try_into().unwrap());
                payment.lamports = payment.lamports.max(lamports);
            }
        } else if *program == MEMO_PROGRAM
            && let Ok(memo) = std::str::from_utf8(&instruction.data)
        {
            payment.memos.push(memo.to_owned());
        }
    }
    payment
}

/// Whether a payment that landed at `block_time` pays for the record of `content`: a transfer to
/// the sponsor of at least what the quote its memo names asked, made before that quote expired.
/// `issued` says what the gateway issued under an id.
pub fn verify_payment(
    payment: &Payment,
    block_time: Option<i64>,
    content: &[u8; 32],
    issued: impl Fn(&str) -> Option<(u64, u32)>,
) -> bool {
    let Some(block_time) = block_time else {
        return false;
    };
    let wanted = hex::encode(content);
    payment.memos.iter().any(|memo| {
        memo.split_once(':')
            .filter(|(hex, _)| *hex == wanted)
            .and_then(|(_, id)| issued(id))
            .is_some_and(|(lamports, expires_at)| {
                payment.lamports >= lamports && block_time <= i64::from(expires_at)
            })
    })
}

enum Failure {
    Refused(Reason),
    Recorded,
    Limited(&'static str, u32),
    Unwritable,
    Other(Error),
}

impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        Failure::Other(error)
    }
}

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        match self {
            Failure::Refused(reason) => (
                StatusCode::BAD_REQUEST,
                Json(json!({ "reason": reason.as_str() })),
            )
                .into_response(),
            Failure::Recorded => {
                (StatusCode::CONFLICT, Json(json!({ "reason": "recorded" }))).into_response()
            }
            Failure::Limited(reason, retry_after) => (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({ "reason": reason, "retryAfter": retry_after })),
            )
                .into_response(),
            Failure::Unwritable => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "records are unavailable" })),
            )
                .into_response(),
            Failure::Other(error) => error.into_response(),
        }
    }
}

fn priority(price: u64, limit: u32) -> u64 {
    price.saturating_mul(u64::from(limit)).div_ceil(1_000_000)
}

/// What a record costs the sponsor at most: the fee for the transaction's signature and the
/// participants', the priority fee at the highest price it pays, and the rent.
async fn cost(state: &Gateway) -> Result<u64, Error> {
    let rent = state
        .rpc
        .get_minimum_balance_for_rent_exemption(Netting::LEN)
        .await
        .map_err(unreachable)?;
    let fee = SIGNATURE_FEE * (1 + MAX_PARTICIPANTS as u64)
        + priority(state.settings.max_priority_fee, COMPUTE_UNIT_LIMIT);
    Ok(quote_lamports(fee, rent))
}

/// The price of a record in the paid lane, valid for a while: pay it to `sponsor` with a memo of
/// the content and the quote's id.
pub(crate) async fn quote(
    State(state): State<Arc<Gateway>>,
) -> Result<Json<serde_json::Value>, Error> {
    let now = chain_now(&read(&state, &[CLOCK_SYSVAR]).await?[0])?;
    let lamports = cost(&state).await?;
    let (id, expires_at) = state
        .nettings
        .quote(lamports, now)
        .map_err(|_| Error::Unfunded)?;
    Ok(Json(json!({
        "quoteId": id,
        "lamports": lamports,
        "sponsor": state.fee_payer.pubkey().to_string(),
        "expiresAt": expires_at,
        "now": now,
    })))
}

/// The netting key files, for the app to download by their hashes.
pub(crate) async fn key(
    State(state): State<Arc<Gateway>>,
) -> Result<Json<serde_json::Value>, Error> {
    let hashes = state
        .nettings
        .keys()
        .ok_or(Error::NotFound("no netting key is offered here"))?;
    let base = state
        .zk
        .keys_url
        .as_deref()
        .ok_or(Error::BadRequest("the key files are not published here"))?;
    let mut offer = keys_body(hashes, hashes, 0, base, 0)["current"].take();
    offer["vkUrl"] = json!(format!("{base}/zk/{}/vk.bin", hex::encode(hashes.vk)));
    Ok(Json(offer))
}

pub(crate) async fn post(
    State(state): State<Arc<Gateway>>,
    Extension(Client(ip)): Extension<Client>,
    body: Bytes,
) -> Response {
    match record(&state, ip, &body).await {
        Ok((status, answer)) => {
            info!(status = status.as_u16(), "netting answered");
            (status, Json(answer)).into_response()
        }
        Err(failure) => {
            let response = failure.into_response();
            info!(status = response.status().as_u16(), "netting refused");
            response
        }
    }
}

async fn record(
    state: &Gateway,
    ip: IpAddr,
    body: &[u8],
) -> Result<(StatusCode, serde_json::Value), Failure> {
    let body: NettingBody =
        serde_json::from_slice(body).map_err(|_| Failure::Refused(Reason::Statement))?;
    // The free lane's limit comes before any verification.
    if body.payment.is_none()
        && let Err(retry_after) = state.nettings.admit_ip(netting_prefix(ip))
    {
        return Err(Failure::Limited("ip", retry_after));
    }
    let statement =
        hex::decode(&body.statement).map_err(|_| Failure::Refused(Reason::Statement))?;
    let signatures: Vec<[u8; 64]> = body
        .signatures
        .iter()
        .map(|signature| hex_array(signature))
        .collect::<Option<_>>()
        .ok_or(Failure::Refused(Reason::Signatures))?;
    let proof: [u8; NETTING_PROOF_RAW] =
        hex_array(&body.proof).ok_or(Failure::Refused(Reason::Proof))?;
    let program = state.settings.program;
    let checked = check(
        &state.nettings.verified,
        &program.id(),
        &state.settings.genesis_hash,
        &statement,
        &signatures,
        &proof,
    )
    .map_err(Failure::Refused)?;
    let expires = checked.statement.expires;

    let reads = read(state, &[CLOCK_SYSVAR, checked.address]).await?;
    let now = chain_now(&reads[0])?;
    if !within_margin(now, expires) {
        return Err(Failure::Refused(Reason::Expired));
    }
    if reads[1]
        .as_ref()
        .is_some_and(|account| is_netting_record(account, expires, &program.id()))
    {
        return Err(Failure::Recorded);
    }
    let payment = match &body.payment {
        Some(signature) => Some(paid(state, signature, &checked.content).await?),
        None => {
            if !state.nettings.has_slot(now) {
                return Err(capped(now));
            }
            None
        }
    };

    let fee_payer = state.fee_payer.pubkey();
    let netting_domain = domain(
        purpose::NETTING,
        &state.settings.genesis_hash,
        &program.id().to_bytes(),
    );
    let instructions = record_instructions(
        &program.id(),
        &netting_domain,
        &fee_payer,
        &statement,
        &signatures,
        &proof,
    );
    let (blockhash, _) = state
        .rpc
        .get_latest_blockhash_with_commitment(state.rpc.commitment())
        .await
        .map_err(unreachable)?;
    let recent = state
        .rpc
        .get_recent_prioritization_fees(&[fee_payer, checked.address])
        .await
        .map_err(unreachable)?;
    let price = priority_fee(
        recent.iter().map(|fee| fee.prioritization_fee).collect(),
        state.settings.max_priority_fee,
    );
    let loaded = loaded_accounts_limit(loaded_accounts_size(state, &instructions).await?);
    let message = compose(
        state,
        &instructions,
        blockhash,
        COMPUTE_UNIT_LIMIT,
        loaded,
        priority(price, COMPUTE_UNIT_LIMIT),
    )?;
    let transaction = VersionedTransaction {
        signatures: vec![state.fee_payer.sign_message(&message.serialize())],
        message,
    };
    let simulation = state
        .rpc
        .simulate_transaction_with_config(
            &VersionedTransaction {
                signatures: vec![Signature::default()],
                message: transaction.message.clone(),
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
        warn!(%failure, "a netting would fail");
        return Err(Failure::Refused(Reason::Rejected));
    }

    // Written down before the send, and never given back.
    match &payment {
        Some(signature) => state
            .nettings
            .use_payment(signature, &checked.content)
            .map_err(|error| match error {
                PaymentError::UsedForAnother => Failure::Refused(Reason::Payment),
                PaymentError::Unwritable(_) => Failure::Unwritable,
            })?,
        None => state.nettings.take(now).map_err(|taken| match taken {
            Taken::Capped(left) => Failure::Limited("cap", left),
            Taken::Unwritable => Failure::Unwritable,
        })?,
    }

    let signature = transaction.signatures[0];
    match send(state, &transaction).await {
        Sent::Refused => Err(Failure::Refused(Reason::Rejected)),
        Sent::Unknown => Ok((
            StatusCode::ACCEPTED,
            json!({ "signature": signature.to_string(), "pending": true }),
        )),
        Sent::Accepted => match confirm(state, &signature).await {
            Outcome::Landed => Ok((
                StatusCode::OK,
                json!({ "signature": signature.to_string() }),
            )),
            Outcome::FailedOnChain => Err(Failure::Refused(Reason::Rejected)),
            Outcome::Unknown => Ok((
                StatusCode::ACCEPTED,
                json!({ "signature": signature.to_string(), "pending": true }),
            )),
        },
    }
}

fn capped(now: u32) -> Failure {
    Failure::Limited(
        "cap",
        86_400 - u32::try_from(u64::from(now) % 86_400).unwrap_or(0),
    )
}

enum Sent {
    Accepted,
    /// The preflight refused it: nothing landed.
    Refused,
    /// The cluster did not say whether it took it.
    Unknown,
}

async fn send(state: &Gateway, transaction: &VersionedTransaction) -> Sent {
    let mut attempt = 1;
    loop {
        match state.rpc.send_transaction(transaction).await {
            Ok(_) => return Sent::Accepted,
            Err(error) => match error.get_transaction_error() {
                Some(solana_transaction_error::TransactionError::BlockhashNotFound)
                    if attempt < SEND_ATTEMPTS =>
                {
                    attempt += 1;
                    tokio::time::sleep(SEND_RETRY_WAIT).await;
                }
                Some(_) => return Sent::Refused,
                None => {
                    warn!("Solana did not say whether it took a netting");
                    return Sent::Unknown;
                }
            },
        }
    }
}

/// Reads the payment at `finalized` and checks it pays for `content`.
async fn paid(state: &Gateway, signature: &str, content: &[u8; 32]) -> Result<String, Failure> {
    let refused = Failure::Refused(Reason::Payment);
    let parsed = Signature::from_str(signature).map_err(|_| Failure::Refused(Reason::Payment))?;
    if !state.nettings.payment_is_free(signature, content) {
        return Err(refused);
    }
    let fetched = state
        .rpc
        .get_transaction_with_config(
            &parsed,
            RpcTransactionConfig {
                encoding: Some(UiTransactionEncoding::Base64),
                commitment: Some(solana_commitment_config::CommitmentConfig::finalized()),
                max_supported_transaction_version: Some(0),
            },
        )
        .await
        .map_err(|_| Failure::Refused(Reason::Payment))?;
    let succeeded = fetched
        .transaction
        .meta
        .as_ref()
        .is_some_and(|meta| meta.err.is_none());
    let Some(transaction) = fetched.transaction.transaction.decode() else {
        return Err(refused);
    };
    let payment = payment_of(&transaction, &state.fee_payer.pubkey());
    if succeeded
        && verify_payment(&payment, fetched.block_time, content, |id| {
            state.nettings.issued(id)
        })
    {
        Ok(signature.to_owned())
    } else {
        Err(refused)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn send_margin_is_sixty_seconds() {
        assert!(super::within_margin(1_000, 1_061));
        assert!(
            !super::within_margin(1_000, 1_060),
            "chain_now + 60 ≥ expires is refused"
        );
        assert!(!super::within_margin(u32::MAX - 10, u32::MAX));
        // A submitter's clock an hour off changes nothing: only the chain's time is an input.
        assert!(super::within_margin(1_000, 1_000 + 3_600));
    }

    #[test]
    fn free_lane_prefix_is_slash_24_and_slash_48() {
        let p = |ip: &str| super::netting_prefix(ip.parse().unwrap());
        assert_eq!(p("203.0.113.7"), p("203.0.113.250"));
        assert_eq!(p("2001:db8:7:1::1"), p("2001:db8:7:ffff::9"));
        assert_ne!(p("2001:db8:7::1"), p("2001:db8:8::1"));
    }

    #[test]
    fn a_used_payment_stays_used_after_a_restart() {
        let path = tempfile::tempdir().unwrap().keep().join("nettings.json");
        let caps = super::NettingCaps {
            daily: 1,
            ip_hourly: 1,
            quote_ttl: 600,
            store: path.clone(),
        };
        super::Nettings::open(caps.clone())
            .unwrap()
            .use_payment("SIG", &[1; 32])
            .unwrap();
        let again = super::Nettings::open(caps).unwrap();
        assert!(
            again.use_payment("SIG", &[2; 32]).is_err(),
            "another content"
        );
        assert!(
            again.use_payment("SIG", &[1; 32]).is_ok(),
            "the same content may retry"
        );
    }

    #[test]
    fn record_predicate_requires_owner_size_discriminator_and_closable_at() {
        use solana_account::Account;
        let program = solana_pubkey::Pubkey::new_unique();
        let expires = 4_000_000_000u32;
        let mut data = vec![0u8; 48];
        data[..8].copy_from_slice(&super::NETTING_DISCRIMINATOR);
        data[44..48].copy_from_slice(&(expires + 30 * 86_400).to_le_bytes());
        let real = Account {
            lamports: 1,
            data: data.clone(),
            owner: program,
            executable: false,
            rent_epoch: 0,
        };
        assert!(super::is_netting_record(&real, expires, &program));
        let other_owner = Account {
            owner: solana_pubkey::Pubkey::default(),
            ..real.clone()
        };
        let longer = Account {
            data: [data.clone(), vec![0]].concat(),
            ..real.clone()
        };
        let mut wrong = data.clone();
        wrong[0] ^= 1;
        let other_disc = Account {
            data: wrong,
            ..real.clone()
        };
        let mut early = data;
        early[44..48].copy_from_slice(&(expires + 30 * 86_400 - 1).to_le_bytes());
        let other_closable = Account {
            data: early,
            ..real.clone()
        };
        for a in [other_owner, longer, other_disc, other_closable] {
            assert!(!super::is_netting_record(&a, expires, &program));
        }
    }

    #[test]
    fn quote_covers_fee_and_rent_with_ten_percent() {
        assert_eq!(super::quote_lamports(50_000, 1_224_960), 1_402_456);
    }
}
