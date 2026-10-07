//! Sponsored settlement and reclaim of notes. A device signs a chain offline; the gateway checks it
//! before it spends anything, reads what the chain says of it, holds a place for it in the float
//! limits, sends the transaction as its fee payer and signs nothing but that transaction. No
//! wallet signs: the device signatures inside the chain are the only authority.
use crate::{
    batches::{Batch, PlanError, RecordView, Step, plan_batches, recorded_prefix},
    chain::{self, SIGNATURE_FEE, TokenAccount, associated_token_address},
    claims,
    fees::priority_fee,
    float::{Kind, NewRecord, Prefix, Refusal, Request as FloatRequest, Sending},
    jobs::{JobState, SettlementJob, verdict},
    onboard::{chain_now, read},
    server::{Client, Error, Gateway},
    sponsored::{Outcome, confirm, hex_array, unreachable},
    transactions::{self, Payout},
};
use axum::{
    Extension, Json,
    extract::State,
    http::{HeaderValue, StatusCode, header::RETRY_AFTER},
    response::{IntoResponse, Response},
};
use buckspay_client::{
    accounts::{Device, Ledger, Lock},
    types::Link,
};
use buckspay_protocol::{
    Issue, MAX_DEPTH, Owner, Signed, Spend,
    chain::{self as rules, Holding, Output},
    hash::{content, domain, purpose},
    lock::Windows,
    reclaim::{reclaim_envelope, record_content},
    record,
    secp256r1::MAX_SIGNATURES,
    verify::{verify_settlement, verify_signature},
    window::{self, Reclaim, Settle},
};
use serde::Deserialize;
use serde_json::json;
use solana_account::Account;
use solana_hash::Hash;
use solana_instruction::Instruction;
use solana_message::{VersionedMessage, v1};
use solana_pubkey::Pubkey;
use solana_rpc_client_api::{config::RpcSimulateTransactionConfig, request::TokenAccountsFilter};
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction_error::TransactionError;
use std::time::Instant;
use std::{net::IpAddr, sync::Arc, time::Duration};
use tracing::{error, info, warn};

/// The least compute unit limit a settlement asks for.
pub(crate) const MIN_COMPUTE_UNIT_LIMIT: u32 = 10_000;

/// The most spends one instruction verifies: eight signatures take the issue and seven spends.
pub const MAX_SPENDS: usize = MAX_SIGNATURES - 1;
/// A chain of seven spends is about 3.6 KiB of hex; the endpoints take this much.
pub const BODY_LIMIT: usize = 16 * 1024;
/// The most spends a chain has: one per hop a note can have. A chain above `MAX_SPENDS` settles in
/// several transactions.
pub const MAX_CHAIN_SPENDS: usize = MAX_DEPTH as usize;
/// The most transactions the gateway sends to settle one chain: three carry sixteen spends.
pub const MAX_BATCHES_PER_CHAIN: usize = 3;
/// The size of a transaction v1.
const TRANSACTION_LIMIT: usize = 4_096;
/// Bytes a signature adds to the message of a transaction.
const SIGNATURE_BYTES: usize = 64;
/// How often the gateway looks again for the records of a batch that landed, and how long it waits
/// between looks.
const LAG_ATTEMPTS: u32 = 20;
const LAG_WAIT: Duration = Duration::from_millis(500);
/// The most compute units a transaction may be given: the heaviest batch of a sixteen-spend chain
/// takes 100,378.
pub const COMPUTE_UNIT_CEILING: u32 = 200_000;
/// The share of the sizes the runtime counts that the loaded accounts limit adds.
const LOADED_ACCOUNTS_MARGIN_PERCENT: u64 = 10;
/// Bytes the runtime counts for an account besides its data.
const ACCOUNT_OVERHEAD: u64 = 64;
/// A record account: its discriminator, content, payer, expiry, retention and flags.
pub const RECORD_LEN: u64 = 81;
/// Where the payer is in a record, for the janitor's search of what the gateway paid for.
pub const RECORD_PAYER_OFFSET: usize = 40;
const UPGRADEABLE_LOADER: Pubkey =
    Pubkey::from_str_const("BPFLoaderUpgradeab1e11111111111111111111111");

/// The first eight bytes of a settlement record: Anchor's discriminator of the account `Spent`.
pub fn spent_discriminator() -> [u8; 8] {
    use sha2::{Digest, Sha256};
    Sha256::digest(b"account:Spent")[..8].try_into().unwrap()
}

/// How many seconds a settlement window must still be open for the gateway to send: a transaction
/// that lands late is a fee wasted. Two minutes in production, a quarter of the grace period where
/// that is shorter.
pub fn margin(windows: &Windows) -> u32 {
    (windows.grace / 4).min(120)
}

#[derive(Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettlementRequest {
    /// The signed issue, hex.
    pub issue: String,
    /// The signed spends in chain order, hex.
    pub spends: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReclaimRequest {
    /// The device key that owns the output, hex.
    pub owner: String,
    pub issue: String,
    pub spends: Vec<String>,
    /// Which output of the last message is taken back: 0 the payment, 1 the change.
    pub which: u8,
    /// The last second the signature may be used.
    pub deadline: u32,
    /// The owner's low-S signature over the reclaim envelope with this deadline, hex.
    pub signature: String,
}

/// Why a settlement or a reclaim is not sponsored, with what the app needs to answer the user:
/// every refusal tells the wallet it can submit the transaction itself.
#[derive(Debug, PartialEq)]
pub enum Problem {
    /// A chain that does not verify, or a request that is not one.
    Invalid(&'static str),
    /// The window of the output is not open: too late to settle, or not the time to reclaim.
    Window(&'static str),
    /// Another message already consumed an output of the chain: the recorded content.
    Conflict([u8; 32]),
    /// The payee has no token account of the mint, and the gateway never creates one.
    NoTokenAccount,
    /// The lock does not exist, does not back the issue or holds too little.
    Lock(&'static str),
    /// The batch is proved under a key the program no longer accepts.
    StaleKey,
    /// The settlement would pay the fee for its records and nothing more.
    BelowFee,
    /// Private settlement is paused or not configured for the mint: it resumes by itself.
    Paused,
    /// The mint's or the lock's draws of the window are used up: seconds until room returns.
    CapExhausted(u32),
    /// The program refuses the claim: nothing the wallet can do by paying for it.
    Claim(&'static str),
    Limits(Refusal, Option<u32>),
}

impl Problem {
    fn parts(&self) -> (StatusCode, serde_json::Value) {
        let (status, mut body) = match self {
            Problem::Invalid(message) => (StatusCode::BAD_REQUEST, json!({ "error": message })),
            Problem::Window(which) => (StatusCode::CONFLICT, json!({ "error": which })),
            Problem::Conflict(recorded) => (
                StatusCode::CONFLICT,
                json!({ "error": "conflict", "recorded": hex::encode(recorded) }),
            ),
            Problem::NoTokenAccount => {
                (StatusCode::CONFLICT, json!({ "error": "no_token_account" }))
            }
            Problem::Lock(message) | Problem::Claim(message) => {
                (StatusCode::CONFLICT, json!({ "error": message }))
            }
            Problem::StaleKey => (StatusCode::CONFLICT, json!({ "error": "stale_key" })),
            Problem::BelowFee => (StatusCode::CONFLICT, json!({ "error": "below_fee" })),
            Problem::Paused => (
                StatusCode::SERVICE_UNAVAILABLE,
                json!({ "error": "paused" }),
            ),
            Problem::CapExhausted(seconds) => (
                StatusCode::SERVICE_UNAVAILABLE,
                json!({ "error": "cap", "retryAfter": seconds }),
            ),
            Problem::Limits(refusal, retry_after) => limits_response(refusal, *retry_after),
        };
        // A refusal the wallet can get round by paying for the transaction itself.
        if !matches!(self, Problem::Invalid(_) | Problem::Claim(_)) {
            body["selfPay"] = json!(true);
        }
        (status, body)
    }

    /// The reason the app is given, which is also what the gateway logs.
    pub(crate) fn code(&self) -> String {
        self.parts().1["error"]
            .as_str()
            .unwrap_or("unknown")
            .to_owned()
    }
}

impl IntoResponse for Problem {
    fn into_response(self) -> Response {
        let (status, body) = self.parts();
        let mut response = (status, Json(body)).into_response();
        if let Problem::Limits(_, Some(seconds)) = self
            && let Ok(value) = HeaderValue::from_str(&seconds.to_string())
        {
            response.headers_mut().insert(RETRY_AFTER, value);
        }
        response
    }
}

fn limits_response(refusal: &Refusal, retry_after: Option<u32>) -> (StatusCode, serde_json::Value) {
    let busy = |error: &str| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": error, "retryAfter": retry_after }),
        )
    };
    let limited = |error: &str| (StatusCode::TOO_MANY_REQUESTS, json!({ "error": error }));
    match refusal {
        Refusal::Horizon { retry_at } => (
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({ "error": "horizon", "retryAt": retry_at }),
        ),
        Refusal::BelowMinimum(minimum) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            json!({ "error": "below_minimum", "minimum": minimum.to_string() }),
        ),
        Refusal::PrefixBusy => limited("network_busy"),
        Refusal::PrefixSpentToday | Refusal::PrefixSpentThisMonth => limited("network_limit"),
        Refusal::KeySpentToday | Refusal::KeySpentThisMonth => limited("key_limit"),
        Refusal::LockSpentToday => limited("lock_limit"),
        Refusal::LockShare { .. } => busy("lock_share"),
        Refusal::TooManyLocks => busy("too_many_locks"),
        Refusal::IssuerLocks => busy("issuer_locks"),
        Refusal::FloatCap => busy("float_cap"),
        Refusal::DailyCap => busy("daily_cap"),
        Refusal::Unwritable => busy("unavailable"),
        Refusal::Expired => busy("expired"),
    }
}

impl From<Problem> for Error {
    fn from(problem: Problem) -> Self {
        Error::Settlement(problem)
    }
}

pub(crate) fn parse_issue(value: &str) -> Result<Signed<Issue>, Problem> {
    let bytes = hex::decode(value).map_err(|_| Problem::Invalid("issue is not hex"))?;
    Signed::<Issue>::decode(&bytes).map_err(|_| Problem::Invalid("issue is not a signed issue"))
}

pub(crate) fn parse_spends(values: &[String]) -> Result<Vec<Signed<Spend>>, Problem> {
    if values.len() > MAX_CHAIN_SPENDS {
        return Err(Problem::Invalid("too many spends for a note"));
    }
    values
        .iter()
        .map(|value| {
            let bytes = hex::decode(value).map_err(|_| Problem::Invalid("spend is not hex"))?;
            Signed::<Spend>::decode(&bytes)
                .map_err(|_| Problem::Invalid("spend is not a signed spend"))
        })
        .collect()
}

/// An output a spend of the chain consumed, as its record keeps it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Consumed {
    pub(crate) output: [u8; 32],
    pub(crate) content: [u8; 32],
    pub(crate) expiry: u32,
    /// Whether the output is `DELEGATED` or `AUTHORITY_ONLY` for its holder: a spend of it is
    /// backed by the chain's lock when it names none.
    pub(crate) unlocked: bool,
}

/// What the program reads of a chain: the keys, envelopes and signatures to verify, the links, the
/// outputs consumed and the outputs of the last message.
pub(crate) struct Walk {
    pub(crate) issue: Issue,
    pub(crate) issue_body: [u8; 163],
    pub(crate) entries: Vec<([u8; 33], [u8; 96], [u8; 64])>,
    pub(crate) links: Vec<Link>,
    pub(crate) consumed: Vec<Consumed>,
    pub(crate) last: Holding,
}

/// Walks the chain with the rules the program applies, refusing an output that cannot be recorded.
pub(crate) fn walk(
    program: &Pubkey,
    note_domain: &[u8; 32],
    issue: &Signed<Issue>,
    spends: &[Signed<Spend>],
) -> Result<Walk, Problem> {
    let invalid = |_| Problem::Invalid("the messages are not a valid chain");
    let (envelope, output) = rules::issue_signing(note_domain, &issue.message).map_err(invalid)?;
    let mut entries = vec![(issue.message.issuer, envelope, issue.signature)];
    let mut last = Holding {
        first: output,
        second: None,
    };
    let (mut links, mut consumed) = (Vec::new(), Vec::new());
    for spend in spends {
        let input: Output = [Some(last.first), last.second]
            .into_iter()
            .flatten()
            .find(|output| output.id == spend.message.input)
            .ok_or(Problem::Invalid(
                "a spend does not consume an output of the previous message",
            ))?;
        let index = u8::from(input.id != last.first.id);
        let (holder, envelope) =
            rules::spend_signing(note_domain, &input, &spend.message).map_err(invalid)?;
        let (next, _) = rules::spend_outputs(&envelope, &input, &spend.message).map_err(invalid)?;
        if record::address(&program.to_bytes(), &input.id).is_none() {
            return Err(Problem::Invalid(
                "an output of the chain cannot be recorded",
            ));
        }
        let mut body = [0; 123];
        let len = spend.message.body(&mut body);
        links.push(Link {
            input: index,
            body: body[..len].to_vec(),
        });
        entries.push((holder, envelope, spend.signature));
        consumed.push(Consumed {
            output: input.id,
            content: content(&body[..len]),
            expiry: input.caveats.expiry,
            unlocked: rules::unlocked(&input.caveats.for_holder(&input.owner)),
        });
        last = next;
    }
    Ok(Walk {
        issue: issue.message,
        issue_body: issue.message.body(),
        entries,
        links,
        consumed,
        last,
    })
}

pub(crate) fn record_address(program: &Pubkey, output: &[u8; 32]) -> Result<Pubkey, Problem> {
    record::address(&program.to_bytes(), output)
        .map(Pubkey::new_from_array)
        .ok_or(Problem::Invalid(
            "an output of the chain cannot be recorded",
        ))
}

/// What a request needs the chain to say, read once at the gateway's commitment.
pub(crate) struct Reads {
    pub(crate) lock: Lock,
    pub(crate) ledger: Ledger,
    pub(crate) now: u32,
    pub(crate) token_program: Pubkey,
    /// The record each presented output has, if any.
    pub(crate) records: Vec<Option<RecordView>>,
}

pub(crate) const PAID: u8 = 1;

/// What a record account holds, or `None` when the account is no record of the program.
pub(crate) fn record_view(program: &Pubkey, account: Option<Account>) -> Option<RecordView> {
    account
        .filter(|account| account.owner == *program && account.data.len() as u64 == RECORD_LEN)
        .map(|account| RecordView {
            content: account.data[8..40].try_into().unwrap(),
            flags: account.data[80],
        })
}

async fn read_chain(state: &Gateway, issue: &Issue, records: &[Pubkey]) -> Result<Reads, Problem> {
    read_chain_with(state, &issue.issuer, issue.lock_seq, records, &[])
        .await
        .map(|(reads, _)| reads)
}

/// The same, with the accounts `extra` read in the same call and returned beside it.
pub(crate) async fn read_chain_with(
    state: &Gateway,
    issuer: &[u8; 33],
    lock_seq: u32,
    records: &[Pubkey],
    extra: &[Pubkey],
) -> Result<(Reads, Vec<Option<Account>>), Problem> {
    let program = state.settings.program;
    let lock_address = program.find_lock_pda(issuer, lock_seq).0;
    let ledger_address = program.find_ledger_pda(&lock_address).0;
    let mut addresses = vec![
        lock_address,
        ledger_address,
        chain::CLOCK_SYSVAR,
        state.settings.mint,
    ];
    addresses.extend_from_slice(records);
    addresses.extend_from_slice(extra);
    let mut accounts = read(state, &addresses).await.map_err(upstream)?;
    let extra = accounts.split_off(accounts.len() - extra.len());
    let lock = accounts[0]
        .as_ref()
        .and_then(|account| Lock::from_bytes(&account.data).ok())
        .ok_or(Problem::Lock("no_lock"))?;
    let ledger = accounts[1]
        .as_ref()
        .and_then(|account| Ledger::from_bytes(&account.data).ok())
        .ok_or(Problem::Lock("no_lock"))?;
    let now = chain_now(&accounts[2]).map_err(upstream)?;
    let token_program = accounts[3]
        .as_ref()
        .map(|mint| mint.owner)
        .ok_or(Problem::Lock("no_mint"))?;
    let records = accounts
        .drain(4..)
        .map(|account| record_view(&program.id(), account))
        .collect();
    let reads = Reads {
        lock,
        ledger,
        now,
        token_program,
        records,
    };
    Ok((reads, extra))
}

pub(crate) const UNREADABLE: &str = "Solana could not be read";

fn upstream(_: Error) -> Problem {
    Problem::Invalid(UNREADABLE)
}

/// A token account of the mint `owner` holds and can be paid to: its associated account when that
/// is one, else the first the cluster lists. The gateway creates none: the rent of a token account
/// is a gift a wallet can take back by closing it.
pub(crate) async fn token_account_of(
    state: &Gateway,
    owner: &Pubkey,
    token_program: &Pubkey,
) -> Result<Pubkey, Error> {
    let mint = state.settings.mint;
    let usable = |account: &Option<Account>| {
        account.as_ref().is_some_and(|account| {
            account.owner == *token_program
                && TokenAccount::parse(&account.data)
                    .is_some_and(|t| t.owner == *owner && t.mint == mint && !t.frozen)
        })
    };
    let associated = associated_token_address(owner, &mint, token_program);
    if usable(&read(state, &[associated]).await?[0]) {
        return Ok(associated);
    }
    let listed = state
        .rpc
        .get_token_accounts_by_owner(owner, TokenAccountsFilter::Mint(mint))
        .await
        .map_err(unreachable)?;
    let candidates: Vec<Pubkey> = listed
        .iter()
        .filter_map(|keyed| keyed.pubkey.parse().ok())
        .collect();
    if candidates.is_empty() {
        return Err(Problem::NoTokenAccount.into());
    }
    let accounts = read(state, &candidates).await?;
    candidates
        .into_iter()
        .zip(accounts)
        .find(|(_, account)| usable(account))
        .map(|(address, _)| address)
        .ok_or_else(|| Problem::NoTokenAccount.into())
}

/// A settlement or a reclaim ready to be sponsored: the instructions and what the limits need to
/// know of them.
pub struct Job {
    pub kind: Kind,
    pub instructions: Vec<Instruction>,
    /// Signatures the fee counts besides the transaction's own: the precompile's.
    pub verified: u64,
    pub request: FloatRequest,
    /// The lock's address, to read its bond again before the send.
    pub lock: Pubkey,
    /// Transactions left to send, this one included: one for a reclaim, and for a settlement the
    /// batches of the chain as the records on chain stand now.
    pub remaining: usize,
    /// The records the whole of what is left creates, which the smallest amount is priced on.
    pub priced: u32,
    /// The spends and the first signed message of this batch, to tell a batch that landed from
    /// the next one.
    pub batch: (usize, usize),
    /// The second after which this settlement can no longer land.
    pub deadline: u32,
    /// The job this send is written down in, when the settlement takes several transactions.
    pub tracked: Option<String>,
    /// The most compute units the transaction may be given.
    pub ceiling: u32,
}

/// What inspecting a request found.
pub enum Planned {
    /// The last record is paid with this very message: nothing to send.
    Settled,
    Send(Box<Job>),
}

pub(crate) fn float_records(
    program: &Pubkey,
    windows: &Windows,
    lock_until: u32,
    presented: &[(Pubkey, u32)],
    existing: &[Option<RecordView>],
) -> Vec<NewRecord> {
    let _ = program;
    presented
        .iter()
        .zip(existing)
        .filter(|(_, state)| state.is_none())
        .map(|((address, expiry), _)| NewRecord {
            address: address.to_bytes(),
            closable_at: u32::try_from(window::closable_at_in(windows, *expiry, lock_until))
                .unwrap_or(u32::MAX),
        })
        .collect()
}

/// Checks a settlement as far as the chain can be asked, without spending anything: the chain
/// verifies, the lock and its ledger back it, no record says otherwise, the window is open and the
/// payee has a token account to be paid to.
pub async fn inspect_settlement(
    state: &Gateway,
    prefix: Prefix,
    request: &SettlementRequest,
) -> Result<Planned, Error> {
    let program = state.settings.program;
    let note_domain = domain(
        purpose::NOTE,
        &state.settings.genesis_hash,
        &program.id().to_bytes(),
    );
    let issue = parse_issue(&request.issue)?;
    let spends = parse_spends(&request.spends)?;
    let settled = verify_settlement(&note_domain, &program.id().to_bytes(), &issue, &spends)
        .map_err(|_| Problem::Invalid("the chain does not verify as a settlement"))?;
    if settled.mint != state.settings.mint.to_bytes() {
        return Err(Problem::Invalid("the note is not of the mint the gateway sponsors").into());
    }
    let Owner::Account(payee) = settled.output.owner else {
        return Err(Problem::Invalid("the chain does not end at a terminal account").into());
    };
    let chain = walk(&program.id(), &note_domain, &issue, &spends)?;

    // The records presented: every consumed output, or the issue's own.
    let presented: Vec<([u8; 32], [u8; 32], u32)> = if chain.consumed.is_empty() {
        vec![(
            chain.last.first.id,
            content(&chain.issue_body),
            chain.issue.caveats.expiry,
        )]
    } else {
        chain
            .consumed
            .iter()
            .map(|c| (c.output, c.content, c.expiry))
            .collect()
    };
    let addresses = presented
        .iter()
        .map(|(output, ..)| record_address(&program.id(), output))
        .collect::<Result<Vec<_>, _>>()?;
    let reads = read_chain(state, &chain.issue, &addresses).await?;
    check_lock(&chain.issue, &reads)?;
    let amount = settled.output.amount;
    if reads.ledger.backing_left < amount {
        return Err(Problem::Lock("insufficient_backing").into());
    }

    // The records: the same message already paid is a result, another content a conflict.
    for ((_, wanted, _), record) in presented.iter().zip(&reads.records) {
        if let Some(record) = record
            && record.content != *wanted
        {
            return Err(Problem::Conflict(record.content).into());
        }
    }
    if let Some(Some(record)) = reads.records.last()
        && record.flags & PAID != 0
    {
        return Ok(Planned::Settled);
    }

    // The window of the last consumed output, with room for the transaction to land.
    let windows = state.settings.windows;
    let expiry = presented[presented.len() - 1].2;
    let latest = reads
        .now
        .checked_add(margin(&windows))
        .ok_or(Problem::Window("window"))?;
    match window::settle_in(&windows, expiry, reads.lock.lock_until, latest) {
        Settle::Open => {}
        Settle::LockEnded => return Err(Problem::Window("lock_ended").into()),
        Settle::Closed => return Err(Problem::Window("window").into()),
    }

    let destination =
        token_account_of(state, &Pubkey::new_from_array(payee), &reads.token_program).await?;
    let wanted: Vec<(Pubkey, u32)> = presented
        .iter()
        .zip(&addresses)
        .map(|((_, _, expiry), address)| (*address, *expiry))
        .collect();
    let lock_address = program
        .find_lock_pda(&chain.issue.issuer, chain.issue.lock_seq)
        .0;
    let payout = Payout {
        payer: state.fee_payer.pubkey(),
        lock: lock_address,
        mint: state.settings.mint,
        token_program: reads.token_program,
        destination,
    };

    // Each batch carries the issue and every body from the issue, and the signatures of the
    // messages from `covered` to its last: the records vouch for the ones before.
    let carried = |batch: &Batch| -> Option<Vec<Instruction>> {
        let end = batch.spends + 1;
        let entries = &chain.entries[batch.covered.min(end)..end];
        let mut instructions = Vec::with_capacity(2);
        if !entries.is_empty() {
            let verified: Vec<_> = entries.iter().map(|entry| (entry.0, entry.1)).collect();
            let signatures: Vec<[u8; 64]> = entries.iter().map(|entry| entry.2).collect();
            instructions.push(transactions::chain_verification(&verified, &signatures)?);
        }
        instructions.push(match batch.step {
            Step::Settle => transactions::settle_note(
                &program,
                &payout,
                chain.issue_body,
                chain.links.clone(),
                &addresses,
            ),
            Step::RecordPrefix => transactions::record_prefix(
                &program,
                payout.payer,
                lock_address,
                chain.issue_body,
                chain.links[..batch.spends].to_vec(),
                &addresses[..batch.spends],
            ),
        });
        Some(instructions)
    };
    let fits = |batch: &Batch| {
        carried(batch).is_some_and(|instructions| {
            compose(
                state,
                &instructions,
                Hash::default(),
                COMPUTE_UNIT_CEILING,
                u32::MAX,
                u64::MAX,
            )
            .is_ok_and(|message| message.serialize().len() + SIGNATURE_BYTES <= TRANSACTION_LIMIT)
        })
    };
    let recorded = recorded_prefix(&chain.consumed, &reads.records);
    let plan = plan_batches(chain.links.len(), recorded, fits).map_err(|error| match error {
        PlanError::TooLong => Problem::Invalid("too many spends for a note"),
        PlanError::DoesNotFit { .. } => {
            Problem::Invalid("a batch of the chain does not fit a transaction")
        }
    })?;
    if plan.len() > MAX_BATCHES_PER_CHAIN {
        error!(
            batches = plan.len(),
            "a chain needs more transactions than the gateway sends"
        );
        return Err(
            Problem::Invalid("the chain needs more transactions than the gateway sends").into(),
        );
    }
    let batch = plan[0];
    let instructions = carried(&batch).ok_or(Problem::Invalid(
        "a batch of the chain does not fit a transaction",
    ))?;
    let priced = float_records(
        &program.id(),
        &windows,
        reads.lock.lock_until,
        &wanted,
        &reads.records,
    )
    .len();
    let in_batch = match batch.step {
        Step::Settle => wanted.len(),
        Step::RecordPrefix => batch.spends,
    };
    let new = float_records(
        &program.id(),
        &windows,
        reads.lock.lock_until,
        &wanted[..in_batch],
        &reads.records[..in_batch],
    );
    let deadline =
        window::settle_deadline_in(&windows, expiry).min(u64::from(reads.lock.lock_until));
    Ok(Planned::Send(Box::new(Job {
        kind: Kind::Settlement,
        instructions,
        verified: batch.signatures() as u64,
        request: FloatRequest {
            kind: Kind::Settlement,
            prefix,
            key: chain.entries.last().map(|entry| entry.0).unwrap(),
            issuer: chain.issue.issuer,
            lock: lock_address.to_bytes(),
            bond: reads.lock.bond,
            amount,
            records: new,
            rent: state.rents().record,
            now: reads.now,
        },
        lock: lock_address,
        remaining: plan.len(),
        priced: priced as u32,
        batch: (batch.spends, batch.covered),
        deadline: u32::try_from(deadline).unwrap_or(u32::MAX),
        tracked: None,
        ceiling: COMPUTE_UNIT_CEILING,
    })))
}

fn check_lock(issue: &Issue, reads: &Reads) -> Result<(), Problem> {
    if reads.lock.mint.to_bytes() != issue.mint || issue.cum_end > reads.lock.backing {
        return Err(Problem::Lock("wrong_lock"));
    }
    Ok(())
}

/// Checks a reclaim the same way: the chain and the owner's signature verify, the window of the
/// output is open and the deadline holds, and the wallet the owner is bound to has a token account.
pub async fn inspect_reclaim(
    state: &Gateway,
    ip: IpAddr,
    request: &ReclaimRequest,
) -> Result<Planned, Error> {
    let program = state.settings.program;
    let note_domain = domain(
        purpose::NOTE,
        &state.settings.genesis_hash,
        &program.id().to_bytes(),
    );
    let reclaim_domain = domain(
        purpose::RECLAIM,
        &state.settings.genesis_hash,
        &program.id().to_bytes(),
    );
    let owner: [u8; 33] =
        hex_array(&request.owner).ok_or(Problem::Invalid("owner is not 33 bytes of hex"))?;
    let signature: [u8; 64] = hex_array(&request.signature)
        .ok_or(Problem::Invalid("signature is not 64 bytes of hex"))?;
    let issue = parse_issue(&request.issue)?;
    if request.spends.len() > MAX_SPENDS - 1 {
        return Err(Problem::Invalid("too many spends for one reclaim").into());
    }
    let spends = parse_spends(&request.spends)?;
    let mut chain = walk(&program.id(), &note_domain, &issue, &spends)?;
    for (key, envelope, signature) in &chain.entries {
        verify_signature(key, envelope, signature)
            .map_err(|_| Problem::Invalid("a signature of the chain does not verify"))?;
    }
    let output = match request.which {
        0 => chain.last.first,
        1 => chain
            .last
            .second
            .ok_or(Problem::Invalid("the last message has no change"))?,
        _ => return Err(Problem::Invalid("which is 0 or 1").into()),
    };
    if output.owner != Owner::Device(owner) {
        return Err(Problem::Invalid("the output is not owned by this key").into());
    }
    let envelope = reclaim_envelope(&reclaim_domain, &output.id, request.deadline);
    verify_signature(&owner, &envelope, &signature)
        .map_err(|_| Problem::Invalid("the owner did not sign this reclaim"))?;
    chain.entries.push((owner, envelope, signature));
    if issue.message.mint != state.settings.mint.to_bytes() {
        return Err(Problem::Invalid("the note is not of the mint the gateway sponsors").into());
    }

    let mut presented: Vec<([u8; 32], [u8; 32], u32)> = chain
        .consumed
        .iter()
        .map(|c| (c.output, c.content, c.expiry))
        .collect();
    presented.push((output.id, record_content(), output.caveats.expiry));
    let addresses = presented
        .iter()
        .map(|(id, ..)| record_address(&program.id(), id))
        .collect::<Result<Vec<_>, _>>()?;
    let device_address = program.find_device_pda(&owner).0;
    let device = read(state, &[device_address])
        .await?
        .remove(0)
        .and_then(|account| Device::from_bytes(&account.data).ok())
        .ok_or(Problem::Invalid("this key is not a registered device"))?;
    let reads = read_chain(state, &chain.issue, &addresses).await?;
    check_lock(&chain.issue, &reads)?;
    if reads.ledger.backing_left < output.amount {
        return Err(Problem::Lock("insufficient_backing").into());
    }
    for ((_, wanted, _), record) in presented.iter().zip(&reads.records) {
        if let Some(record) = record
            && record.content != *wanted
        {
            return Err(Problem::Conflict(record.content).into());
        }
    }
    if let Some(Some(record)) = reads.records.last()
        && record.flags & PAID != 0
    {
        return Ok(Planned::Settled);
    }

    let windows = state.settings.windows;
    match window::reclaim_in(
        &windows,
        output.caveats.expiry,
        reads.lock.lock_until,
        reads.now,
    ) {
        Reclaim::Open => {}
        Reclaim::TooEarly => return Err(Problem::Window("window").into()),
        Reclaim::Closed => return Err(Problem::Window("closed").into()),
        Reclaim::LockEnded => return Err(Problem::Window("lock_ended").into()),
    }
    let latest = reads
        .now
        .checked_add(margin(&windows))
        .ok_or(Problem::Window("deadline"))?;
    if latest > request.deadline {
        return Err(Problem::Window("deadline").into());
    }

    let destination = token_account_of(state, &device.wallet, &reads.token_program).await?;
    let new = float_records(
        &program.id(),
        &windows,
        reads.lock.lock_until,
        &presented
            .iter()
            .zip(&addresses)
            .map(|((_, _, expiry), address)| (*address, *expiry))
            .collect::<Vec<_>>(),
        &reads.records,
    );
    let signatures: Vec<[u8; 64]> = chain.entries.iter().map(|entry| entry.2).collect();
    let verified: Vec<_> = chain
        .entries
        .iter()
        .map(|entry| (entry.0, entry.1))
        .collect();
    let verification = transactions::chain_verification(&verified, &signatures).ok_or(
        Problem::Invalid("the chain is too long for one verification"),
    )?;
    let lock_address = program
        .find_lock_pda(&chain.issue.issuer, chain.issue.lock_seq)
        .0;
    let payout = Payout {
        payer: state.fee_payer.pubkey(),
        lock: lock_address,
        mint: state.settings.mint,
        token_program: reads.token_program,
        destination,
    };
    let reclaim = transactions::reclaim_output(
        &program,
        &payout,
        owner,
        chain.issue_body,
        chain.links,
        request.which,
        request.deadline,
        &addresses,
    );
    let new_records = new.len();
    Ok(Planned::Send(Box::new(Job {
        kind: Kind::Reclaim,
        instructions: vec![verification, reclaim],
        verified: signatures.len() as u64,
        request: FloatRequest {
            kind: Kind::Reclaim,
            prefix: ip.into(),
            key: owner,
            issuer: chain.issue.issuer,
            lock: lock_address.to_bytes(),
            bond: reads.lock.bond,
            amount: output.amount,
            records: new,
            rent: state.rents().record,
            now: reads.now,
        },
        lock: lock_address,
        remaining: 1,
        priced: new_records as u32,
        batch: (0, 0),
        deadline: u32::MAX,
        tracked: None,
        ceiling: COMPUTE_UNIT_CEILING,
    })))
}

/// The bytes the runtime counts as loaded for a transaction with these instructions: 64 bytes and
/// the data of every account it names, the fee payer included, and the programdata of every
/// program of the upgradeable loader.
pub async fn loaded_accounts_size(
    state: &Gateway,
    instructions: &[Instruction],
) -> Result<u32, Error> {
    let mut keys = vec![state.fee_payer.pubkey()];
    for instruction in instructions {
        keys.push(instruction.program_id);
        keys.extend(instruction.accounts.iter().map(|meta| meta.pubkey));
    }
    keys.sort();
    keys.dedup();
    let accounts = read(state, &keys).await?;
    let mut total: u64 = 0;
    let mut programdata = Vec::new();
    for account in &accounts {
        total += ACCOUNT_OVERHEAD + account.as_ref().map_or(0, |a| a.data.len() as u64);
        if let Some(account) = account
            && account.executable
            && account.owner == UPGRADEABLE_LOADER
            && account.data.len() >= 36
        {
            programdata.push(Pubkey::new_from_array(
                account.data[4..36].try_into().unwrap(),
            ));
        }
    }
    programdata.sort();
    programdata.dedup();
    for account in read(state, &programdata).await? {
        total += ACCOUNT_OVERHEAD + account.map_or(0, |a| a.data.len() as u64);
    }
    Ok(u32::try_from(total).unwrap_or(u32::MAX))
}

/// The limit the transaction asks for: what the runtime counts plus a tenth, never a constant: an
/// upgrade of the program changes it.
pub(crate) fn loaded_accounts_limit(counted: u32) -> u32 {
    let margin = u64::from(counted) * LOADED_ACCOUNTS_MARGIN_PERCENT / 100;
    u32::try_from(u64::from(counted) + margin).unwrap_or(u32::MAX)
}

pub(crate) fn compose(
    state: &Gateway,
    instructions: &[Instruction],
    blockhash: Hash,
    compute_unit_limit: u32,
    loaded_accounts: u32,
    priority_fee: u64,
) -> Result<VersionedMessage, Error> {
    compose_for(
        &state.fee_payer.pubkey(),
        instructions,
        blockhash,
        compute_unit_limit,
        loaded_accounts,
        priority_fee,
    )
}

/// The same for a fee payer that is given.
pub(crate) fn compose_for(
    fee_payer: &Pubkey,
    instructions: &[Instruction],
    blockhash: Hash,
    compute_unit_limit: u32,
    loaded_accounts: u32,
    priority_fee: u64,
) -> Result<VersionedMessage, Error> {
    let config = v1::TransactionConfig {
        priority_fee: Some(priority_fee),
        compute_unit_limit: Some(compute_unit_limit),
        loaded_accounts_data_size_limit: Some(loaded_accounts),
        heap_size: None,
    };
    v1::Message::try_compile_with_config(fee_payer, instructions, blockhash, config)
        .map(VersionedMessage::V1)
        .map_err(|_| Error::BadRequest("the transaction cannot be built"))
}

/// The runtime's own count of loaded account bytes for a transaction of `instructions`, from a
/// simulation: the figure `loaded_accounts_size` has to match.
pub async fn simulated_loaded_accounts_size(
    state: &Gateway,
    instructions: &[Instruction],
) -> Result<u32, Error> {
    let (blockhash, _) = state
        .rpc
        .get_latest_blockhash_with_commitment(state.rpc.commitment())
        .await
        .map_err(unreachable)?;
    let message = compose(
        state,
        instructions,
        blockhash,
        COMPUTE_UNIT_CEILING,
        u32::MAX / 2,
        0,
    )?;
    let simulation = state
        .rpc
        .simulate_transaction_with_config(
            &VersionedTransaction {
                signatures: vec![Signature::default()],
                message,
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
    simulation.loaded_accounts_data_size.ok_or(Error::Upstream)
}

/// Sponsors a reclaim: one transaction, and its signature.
async fn sponsor(state: &Gateway, job: Job) -> Result<Json<serde_json::Value>, Error> {
    let signature = sponsor_send(state, job).await?;
    Ok(Json(json!({ "signature": signature.to_string() })))
}

/// Sponsors a transaction of a job: holds its place in the limits, builds and simulates it, writes
/// the send down, sends it as the fee payer and waits for the outcome. Every limit is checked
/// twice, once here and once immediately before the send.
pub(crate) async fn sponsor_send(state: &Gateway, job: Job) -> Result<Signature, Error> {
    let reservation = state
        .settlements
        .reserve_priced(job.request.clone(), job.priced)
        .map_err(|refusal| limits(state, refusal, job.request.now))?;
    let fee_payer = state.fee_payer.pubkey();
    let (blockhash, last_valid_block_height) = state
        .rpc
        .get_latest_blockhash_with_commitment(state.rpc.commitment())
        .await
        .map_err(unreachable)?;
    let recent = state
        .rpc
        .get_recent_prioritization_fees(&[fee_payer, job.lock])
        .await
        .map_err(unreachable)?;
    let price = priority_fee(
        recent.iter().map(|fee| fee.prioritization_fee).collect(),
        state.settings.max_priority_fee,
    );
    let loaded = loaded_accounts_limit(loaded_accounts_size(state, &job.instructions).await?);
    // The price is charged on the limit the transaction asks for, not on what it uses.
    let priority = |limit: u32| price.saturating_mul(u64::from(limit)).div_ceil(1_000_000);

    let draft = compose(
        state,
        &job.instructions,
        blockhash,
        job.ceiling,
        loaded,
        priority(job.ceiling),
    )?;
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
        warn!(%failure, "a settlement would fail");
        if let (Some(key), Some(ended)) = (
            &job.tracked,
            verdict(&TransactionError::from(failure.clone())),
        ) {
            finish(state.jobs.end(key, ended));
        }
        return Err(Error::Rejected);
    }
    let used = simulation.units_consumed.unwrap_or(0);
    let limit = u32::try_from(used + used * 3 / 10)
        .unwrap_or(job.ceiling)
        .clamp(MIN_COMPUTE_UNIT_LIMIT, job.ceiling);
    let fee = SIGNATURE_FEE * (1 + job.verified) + priority(limit);
    let message = compose(
        state,
        &job.instructions,
        blockhash,
        limit,
        loaded,
        priority(limit),
    )?;
    let transaction = VersionedTransaction {
        signatures: vec![state.fee_payer.sign_message(&message.serialize())],
        message,
    };

    // The send is written down first, with the lock's bond and the chain's clock as they are now.
    let accounts = read(state, &[job.lock, chain::CLOCK_SYSVAR]).await?;
    let bond = accounts[0]
        .as_ref()
        .and_then(|account| Lock::from_bytes(&account.data).ok())
        .ok_or(Error::Upstream)?
        .bond;
    let now = chain_now(&accounts[1])?;
    let slot = state.rpc.get_slot().await.map_err(unreachable)?;
    let sending = reservation
        .begin(now, slot, bond)
        .map_err(|refusal| limits(state, refusal, now))?;
    if let Some(key) = &job.tracked
        && state
            .jobs
            .sent(
                key,
                &transaction.signatures[0].to_string(),
                last_valid_block_height,
            )
            .is_err()
    {
        warn!("a settlement job could not be written; nothing was sent");
        finish(sending.failed(0));
        return Err(Error::Upstream);
    }

    let signature = match state.rpc.send_transaction(&transaction).await {
        Ok(signature) => signature,
        Err(error) if error.get_transaction_error().is_some() => {
            // Refused by the preflight after it was written down: nothing landed and no fee is
            // owed, but the attempt still counts.
            warn!("a settlement failed its preflight");
            finish(sending.failed(0));
            return Err(Error::Rejected);
        }
        Err(_) => {
            warn!("Solana did not say whether it took a settlement");
            finish(sending.unknown());
            return Err(Error::Upstream);
        }
    };
    info!(%signature, "settlement sent");
    resolve(state, sending, &signature, fee).await?;
    Ok(signature)
}

pub(crate) fn finish(result: std::io::Result<()>) {
    if let Err(error) = result {
        error!(%error, "the settlement ledger could not be written; sponsoring stopped");
    }
}

/// Settles a send by what Solana reported of it.
async fn resolve(
    state: &Gateway,
    sending: Sending,
    signature: &Signature,
    fee: u64,
) -> Result<(), Error> {
    match confirm(state, signature).await {
        Outcome::Landed => {
            let slot = state.rpc.get_slot().await.unwrap_or_default();
            finish(sending.landed(slot));
            Ok(())
        }
        Outcome::FailedOnChain => {
            finish(sending.failed(fee));
            Err(Error::Failed)
        }
        Outcome::Unknown => {
            finish(sending.unknown());
            Err(Error::Upstream)
        }
    }
}

pub(crate) fn limits(state: &Gateway, refusal: Refusal, now: u32) -> Error {
    let retry_after = match refusal {
        Refusal::Horizon { .. } | Refusal::BelowMinimum(_) => None,
        _ => state
            .settlements
            .next_closable(now)
            .map(|at| at.saturating_sub(now).max(1)),
    };
    Problem::Limits(refusal, retry_after).into()
}

/// The key of a settlement job: what the request names, so that the same chain is the same job.
pub(crate) fn job_key(request: &SettlementRequest) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(request.issue.as_bytes());
    for spend in &request.spends {
        hash.update([0]);
        hash.update(spend.as_bytes());
    }
    hex::encode(&hash.finalize()[..16])
}

/// The state a refusal of a settlement puts its job in, when it is for good.
pub(crate) fn ended(error: &Error) -> Option<JobState> {
    match error {
        Error::Settlement(Problem::Window(_)) => Some(JobState::Expired),
        Error::Settlement(Problem::Conflict(_) | Problem::Lock("insufficient_backing")) => {
            Some(JobState::Conflict)
        }
        Error::Settlement(Problem::Lock(_) | Problem::StaleKey | Problem::BelowFee) => {
            Some(JobState::Refused)
        }
        Error::Settlement(Problem::Invalid(reason)) if *reason != UNREADABLE => {
            Some(JobState::Refused)
        }
        _ => None,
    }
}

/// Settles a chain: sends the transactions it takes, one after the other, each planned from what
/// the records on chain say when it is sent. A chain that takes several is written down before
/// the first send, so that the janitor finishes it if this task does not.
pub(crate) async fn drive(
    state: &Gateway,
    prefix: Prefix,
    request: &SettlementRequest,
    key: &str,
) -> Result<serde_json::Value, Error> {
    let Some(_driving) = state.jobs.drive(key) else {
        return Err(Error::Busy);
    };
    let (mut done, mut previous, mut lag) = (0usize, None, 0);
    loop {
        let job = match inspect_settlement(state, prefix, request).await {
            Ok(Planned::Settled) => {
                finish(state.jobs.end(key, JobState::Done));
                return Ok(if done == 0 {
                    json!({ "status": "settled" })
                } else {
                    json!({ "status": "settled", "batches": { "done": done, "total": done } })
                });
            }
            Ok(Planned::Send(job)) => *job,
            Err(error) => {
                if let Some(state_of_job) = ended(&error) {
                    finish(state.jobs.end(key, state_of_job));
                }
                return Err(error);
            }
        };
        // The batch that landed is still what the records say: the read is behind.
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
        let tracked = state.jobs.get(key).is_some() || !last;
        if tracked && state.jobs.get(key).is_none() {
            let written = state.jobs.begin(SettlementJob {
                key: key.to_owned(),
                issue: request.issue.clone(),
                spends: request.spends.clone(),
                prefix,
                created_at: job.request.now,
                deadline: job.deadline,
                batches_done: 0,
                state: JobState::Pending,
                last_signature: None,
                last_valid_block_height: None,
                not_before: None,
                zk: None,
                word: None,
            });
            if written.is_err() {
                warn!("a settlement job could not be written; nothing was sent");
                return Err(Error::Upstream);
            }
        }
        let signature = sponsor_send(
            state,
            Job {
                tracked: tracked.then(|| key.to_owned()),
                ..job
            },
        )
        .await?;
        done += 1;
        if last {
            finish(state.jobs.end(key, JobState::Done));
            return Ok(json!({
                "signature": signature.to_string(),
                "batches": { "done": done, "total": done },
            }));
        }
        finish(state.jobs.landed(key));
        previous = Some(batch);
    }
}

/// Continues a job the gateway started and did not finish. Nothing is sent before the last
/// transaction sent has landed or can no longer land: what is sent is what the records say.
pub(crate) async fn resume(state: &Gateway, job: &SettlementJob) {
    if job
        .not_before
        .is_some_and(|at| crate::onboard::local_now() < at)
    {
        return;
    }
    if crate::onboard::local_now() > job.deadline {
        finish(state.jobs.end(&job.key, JobState::Expired));
        return;
    }
    if let (Some(signature), Some(last_valid)) = (&job.last_signature, job.last_valid_block_height)
        && let Ok(signature) = signature.parse::<Signature>()
    {
        let known = match state.rpc.get_signature_statuses(&[signature]).await {
            Ok(statuses) => statuses.value.into_iter().next().flatten().is_some(),
            Err(_) => return,
        };
        if !known {
            match state.rpc.get_block_height().await {
                Ok(height) if height > last_valid => {}
                _ => return,
            }
        }
    }
    if let Some(private) = &job.zk {
        match crate::zk::resume(state, job, private).await {
            Ok(answer) => info!(%answer, "a private settlement job moved on"),
            Err(_) => warn!("a private settlement job could not move on"),
        }
        return;
    }
    let request = SettlementRequest {
        issue: job.issue.clone(),
        spends: job.spends.clone(),
    };
    match drive(state, job.prefix, &request, &job.key).await {
        Ok(answer) => info!(%answer, "a settlement job moved on"),
        Err(error) => {
            warn!("a settlement job could not move on");
            if matches!(ended(&error), Some(JobState::Conflict)) {
                // What made the settlement fail is the evidence of a loss.
                let _ = claims::file(state, &request).await;
            }
        }
    }
}

/// What `/v1/settlements` takes: a chain in the clear, or a private settlement by proofs.
#[derive(Deserialize)]
#[serde(untagged)]
pub(crate) enum Body {
    Private(crate::zk::ZkRequest),
    Clear(SettlementRequest),
}

pub(crate) async fn settle(
    State(state): State<Arc<Gateway>>,
    Extension(Client(ip)): Extension<Client>,
    Json(body): Json<Body>,
) -> Response {
    let started = Instant::now();
    let (route, id, spends) = match &body {
        Body::Clear(request) => (
            "clear",
            job_key(request)[..8].to_owned(),
            request.spends.len(),
        ),
        Body::Private(request) => (
            "private",
            crate::zk::short_id(request),
            request.messages.len(),
        ),
    };
    let result = match body {
        Body::Private(request) => crate::zk::submit(&state, ip.into(), request).await,
        Body::Clear(request) => settle_clear(state, ip.into(), request).await,
    };
    answered(route, &id, spends, started, result)
}

async fn settle_clear(
    state: Arc<Gateway>,
    prefix: Prefix,
    request: SettlementRequest,
) -> Result<Json<serde_json::Value>, Error> {
    match drive(&state, prefix, &request, &job_key(&request)).await {
        Ok(answer) => Ok(Json(answer)),
        Err(error) => {
            // What made the settlement fail is the evidence of a loss: nobody has to ask for it.
            if matches!(
                &error,
                Error::Settlement(Problem::Conflict(_) | Problem::Lock("insufficient_backing"))
            ) {
                claims::file_in_background(state, request);
            }
            Err(error)
        }
    }
}

/// Logs how a settlement request ended, with only its reason code, a short id that cannot be
/// reversed, the spend count and the time it took, and returns the response.
fn answered(
    route: &str,
    id: &str,
    spends: usize,
    started: Instant,
    result: Result<Json<serde_json::Value>, Error>,
) -> Response {
    let code = match &result {
        Ok(_) => "ok".to_owned(),
        Err(error) => error.code(),
    };
    let response = result.into_response();
    info!(
        route,
        id,
        spends,
        status = response.status().as_u16(),
        code,
        elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        "settlement answered"
    );
    response
}

pub(crate) async fn reclaim(
    State(state): State<Arc<Gateway>>,
    Extension(Client(ip)): Extension<Client>,
    Json(request): Json<ReclaimRequest>,
) -> Result<Json<serde_json::Value>, Error> {
    match inspect_reclaim(&state, ip, &request).await? {
        Planned::Settled => Ok(Json(json!({ "status": "settled" }))),
        Planned::Send(job) => sponsor(&state, *job).await,
    }
}

/// What the gateway quotes and enforces for sponsored settlements right now.
pub(crate) async fn quote(State(state): State<Arc<Gateway>>) -> Json<serde_json::Value> {
    let status = state.settlements.status(crate::onboard::local_now());
    Json(json!({
        "minAmount": status.min_amount.to_string(),
        "pressure": status.pressure_percent,
        "openRecords": status.open_records,
        "locks": status.locks,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::float::SettlementLimits;

    #[test]
    fn the_margin_is_two_minutes_in_production_and_a_quarter_of_the_grace_where_that_is_less() {
        assert_eq!(margin(&Windows::PRODUCTION), 120);
        assert_eq!(margin(&Windows::SHORT), 15);
    }

    #[test]
    fn the_limit_is_what_the_runtime_counts_plus_a_tenth() {
        assert_eq!(loaded_accounts_limit(0), 0);
        assert_eq!(loaded_accounts_limit(468_863), 515_749);
        assert_eq!(loaded_accounts_limit(u32::MAX), u32::MAX);
    }

    #[test]
    fn a_refusal_that_waits_carries_when_and_the_wallet_is_told_it_can_pay_itself() {
        let waits = Problem::Limits(Refusal::FloatCap, Some(90)).into_response();
        assert_eq!(waits.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(waits.headers().get(RETRY_AFTER).unwrap(), "90");
        let invalid = Problem::Invalid("no").into_response();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        assert!(invalid.headers().get(RETRY_AFTER).is_none());
    }

    #[test]
    fn a_send_that_landed_and_failed_counts_against_the_key_but_not_the_float() {
        use crate::{float::Caps, limits::Prefix};
        let limits = SettlementLimits::new(Caps::pilot(Windows::PRODUCTION.record_ttl()));
        let request = FloatRequest {
            kind: Kind::Settlement,
            prefix: Prefix::V4([10, 0, 0]),
            key: [1; 33],
            issuer: [2; 33],
            lock: [3; 32],
            bond: 1_000_000_000,
            amount: 1_000_000,
            records: vec![NewRecord {
                address: [4; 32],
                closable_at: 1_900_000_000 + 31 * 86_400,
            }],
            rent: 1_061_720,
            now: 1_900_000_000,
        };
        let sending = limits
            .reserve(request)
            .unwrap()
            .begin(1_900_000_000, 10, 1_000_000_000)
            .unwrap();
        assert_eq!(limits.open_records(), 1);
        sending.failed(15_000).unwrap();
        assert_eq!((limits.open_records(), limits.failed_fees()), (0, 15_000));
        assert_eq!(
            limits.sponsored_by_prefix(Prefix::V4([10, 0, 0]), 1_900_000_000),
            1,
            "the attempt still counts against the network"
        );
    }

    #[derive(Clone, Default)]
    struct Capture(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
        type Writer = Capture;

        fn make_writer(&'a self) -> Capture {
            self.clone()
        }
    }

    fn logged(result: Result<Json<serde_json::Value>, Error>) -> (StatusCode, String) {
        let capture = Capture::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(capture.clone())
            .with_ansi(false)
            .finish();
        let response = tracing::subscriber::with_default(subscriber, || {
            answered("clear", "0a1b2c3d", 1, Instant::now(), result)
        });
        let text = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
        (response.status(), text)
    }

    #[test]
    fn a_refusal_is_logged_with_its_code_status_id_and_spend_count() {
        let refused = Error::Settlement(Problem::Limits(Refusal::LockShare { allowed: 0 }, None));
        let (status, line) = logged(Err(refused));
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        for expected in [
            " INFO ",
            "code=\"lock_share\"",
            "status=503",
            "id=\"0a1b2c3d\"",
            "spends=1",
            "elapsed_ms=",
        ] {
            assert!(line.contains(expected), "{expected} missing from {line}");
        }
        assert!(!line.contains("allowed"));
    }

    #[test]
    fn an_answer_that_settles_is_logged_too() {
        let (status, line) = logged(Ok(Json(json!({ "status": "settled" }))));
        assert_eq!(status, StatusCode::OK);
        assert!(
            line.contains("code=\"ok\"") && line.contains("status=200"),
            "{line}"
        );
    }

    #[test]
    fn a_busy_gateway_and_a_request_that_is_not_valid_are_logged() {
        let (status, line) = logged(Err(Error::Busy));
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(line.contains("code=\"busy\""), "{line}");
        let (_, line) = logged(Err(Problem::Invalid("issue is not hex").into()));
        assert!(line.contains("code=\"issue is not hex\""), "{line}");
    }

    #[test]
    fn the_code_of_every_refusal_is_the_one_the_app_receives() {
        let refusals = [
            Refusal::Unwritable,
            Refusal::DailyCap,
            Refusal::BelowMinimum(1),
            Refusal::Horizon { retry_at: 1 },
            Refusal::PrefixBusy,
            Refusal::PrefixSpentToday,
            Refusal::PrefixSpentThisMonth,
            Refusal::KeySpentToday,
            Refusal::KeySpentThisMonth,
            Refusal::LockSpentToday,
            Refusal::LockShare { allowed: 0 },
            Refusal::TooManyLocks,
            Refusal::IssuerLocks,
            Refusal::FloatCap,
            Refusal::Expired,
        ];
        let expected = [
            "unavailable",
            "daily_cap",
            "below_minimum",
            "horizon",
            "network_busy",
            "network_limit",
            "network_limit",
            "key_limit",
            "key_limit",
            "lock_limit",
            "lock_share",
            "too_many_locks",
            "issuer_locks",
            "float_cap",
            "expired",
        ];
        for (refusal, code) in refusals.into_iter().zip(expected) {
            assert_eq!(Problem::Limits(refusal, None).code(), code);
        }
        assert_eq!(Problem::Paused.code(), "paused");
        assert_eq!(Problem::CapExhausted(5).code(), "cap");
        assert_eq!(Problem::Lock("no_lock").code(), "no_lock");
    }
}
