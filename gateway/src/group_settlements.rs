//! Settles several notes in as few transactions as fit. Each note is inspected like a single
//! settlement and holds its job key until its outcome is resolved, the float is reserved for every
//! note of a transaction at once, and a note that fails is refused alone: the others are repacked,
//! unless the failure is a race with another settlement, which would only repeat.
use crate::{
    chain::{CLOCK_SYSVAR, SIGNATURE_FEE},
    fees::priority_fee,
    float::{Prefix, Refusal, Reservation},
    jobs::{JobState, verdict},
    onboard::{chain_now, read},
    server::{Client, Error, Gateway},
    settlements::{
        COMPUTE_UNIT_CEILING, Job, MIN_COMPUTE_UNIT_LIMIT, Planned, Problem, SettlementRequest,
        UNREADABLE, compose, finish, inspect_settlement, job_key, limits, loaded_accounts_limit,
        loaded_accounts_size,
    },
    sponsored::unreachable,
};
use axum::{Extension, Json, extract::State};
use buckspay_client::{accounts::Lock, errors::BuckspayError as E};
use serde::Deserialize;
use serde_json::json;
use solana_hash::Hash;
use solana_instruction::{Instruction, error::InstructionError};
use solana_pubkey::Pubkey;
use solana_rpc_client_api::config::RpcSimulateTransactionConfig;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction_error::TransactionError;
use std::{
    collections::HashSet,
    sync::Arc,
    time::{Duration, Instant},
};
use tracing::{info, warn};

/// The most notes one request settles.
pub const MAX_GROUP: usize = 8;
const TRANSACTION_LIMIT: usize = 4_096;
const SIGNATURE_BYTES: usize = 64;
/// The most compute units a transaction may be given.
const TRANSACTION_COMPUTE_UNITS: u32 = 1_400_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupRequest {
    pub settlements: Vec<SettlementRequest>,
}

/// The notes of one transaction and its instructions; `owner[k]` is the request index of
/// instruction `k`.
pub struct Packed {
    pub notes: Vec<usize>,
    pub instructions: Vec<Instruction>,
    pub owner: Vec<usize>,
}

/// Packs the notes greedily in request order; `fits` says whether a set of instructions still
/// makes one transaction.
pub fn pack(
    jobs: &[(usize, Vec<Instruction>)],
    fits: impl Fn(&[Instruction]) -> bool,
) -> Vec<Packed> {
    let mut packs: Vec<Packed> = Vec::new();
    for (note, instructions) in jobs {
        if let Some(last) = packs.last_mut() {
            let mut joined = last.instructions.clone();
            joined.extend(instructions.iter().cloned());
            if fits(&joined) {
                last.notes.push(*note);
                last.owner
                    .extend(std::iter::repeat_n(*note, instructions.len()));
                last.instructions = joined;
                continue;
            }
        }
        packs.push(Packed {
            notes: vec![*note],
            instructions: instructions.clone(),
            owner: vec![*note; instructions.len()],
        });
    }
    packs
}

/// The request index whose instruction failed, if the error names an instruction.
pub fn failing_note(packed: &Packed, error: &TransactionError) -> Option<usize> {
    match error {
        TransactionError::InstructionError(index, _) => {
            packed.owner.get(usize::from(*index)).copied()
        }
        _ => None,
    }
}

fn refusal_code(refusal: &Refusal) -> &'static str {
    match refusal {
        Refusal::Unwritable => "unwritable",
        Refusal::DailyCap => "daily_cap",
        Refusal::BelowMinimum(_) => "below_minimum",
        Refusal::Horizon { .. } => "horizon",
        Refusal::PrefixBusy => "prefix_busy",
        Refusal::PrefixSpentToday => "prefix_spent_today",
        Refusal::PrefixSpentThisMonth => "prefix_spent_this_month",
        Refusal::KeySpentToday => "key_spent_today",
        Refusal::KeySpentThisMonth => "key_spent_this_month",
        Refusal::LockSpentToday => "lock_spent_today",
        Refusal::LockShare { .. } => "lock_share",
        Refusal::TooManyLocks => "too_many_locks",
        Refusal::IssuerLocks => "issuer_locks",
        Refusal::FloatCap => "float_cap",
        Refusal::Expired => "expired",
    }
}

fn reason(error: &Error) -> String {
    match error {
        Error::Settlement(Problem::Invalid(message)) if *message == UNREADABLE => {
            "upstream".to_owned()
        }
        Error::Settlement(Problem::Invalid(_)) => "invalid".to_owned(),
        Error::Settlement(Problem::Limits(refusal, _)) => {
            format!("limits:{}", refusal_code(refusal))
        }
        Error::Settlement(problem) => problem.code(),
        other => other.code(),
    }
}

/// Why a transaction failed at a note, and whether that is a race with another settlement of it.
fn failure_reason(error: &TransactionError, fallback: &str) -> (String, bool) {
    if let TransactionError::InstructionError(_, InstructionError::Custom(code)) = error {
        if *code == E::AlreadySettled as u32 {
            return ("spent".to_owned(), true);
        }
        if *code == E::ConflictingSpend as u32 {
            return ("conflict".to_owned(), true);
        }
        if verdict(error) == Some(JobState::Refused) {
            return ("refused".to_owned(), false);
        }
    }
    (fallback.to_owned(), false)
}

#[derive(Default)]
struct Answer {
    sent: Vec<(String, Vec<usize>)>,
    refused: Vec<(usize, String)>,
}

/// What a transaction needs of a note once the note is not borrowed from the pending ones.
struct Member {
    request: crate::float::Request,
    priced: u32,
    lock: Pubkey,
    verified: u64,
}

enum Flow {
    Continue,
    Stop,
}

/// What Solana reported of a transaction that was sent.
enum Confirmed {
    Landed,
    Failed(TransactionError),
    Unknown,
}

async fn confirmed(state: &Gateway, signature: &Signature) -> Confirmed {
    use solana_transaction_status_client_types::TransactionConfirmationStatus as Status;
    let deadline = Instant::now() + state.settings.confirm_timeout;
    while Instant::now() < deadline {
        if let Ok(statuses) = state.rpc.get_signature_statuses(&[*signature]).await
            && let Some(Some(status)) = statuses.value.first()
        {
            if let Some(error) = &status.err {
                return Confirmed::Failed(error.clone());
            }
            if matches!(
                status.confirmation_status,
                Some(Status::Confirmed | Status::Finalized)
            ) {
                return Confirmed::Landed;
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    Confirmed::Unknown
}

fn fits(state: &Gateway, program: &Pubkey, instructions: &[Instruction]) -> bool {
    let notes = instructions
        .iter()
        .filter(|instruction| instruction.program_id == *program)
        .count();
    u32::try_from(notes)
        .is_ok_and(|notes| notes * COMPUTE_UNIT_CEILING <= TRANSACTION_COMPUTE_UNITS)
        && compose(
            state,
            instructions,
            Hash::default(),
            TRANSACTION_COMPUTE_UNITS,
            u32::MAX,
            u64::MAX,
        )
        .is_ok_and(|message| message.serialize().len() + SIGNATURE_BYTES <= TRANSACTION_LIMIT)
}

impl Answer {
    fn refuse(&mut self, index: usize, reason: impl Into<String>) {
        self.refused.push((index, reason.into()));
    }

    /// Every note still waiting is told to ask again.
    fn retry_rest(&mut self, pending: &mut Vec<(usize, Job)>) {
        for (index, _) in pending.drain(..) {
            self.refused.push((index, "retry".to_owned()));
        }
    }

    /// A transaction failed, in its simulation or on chain, and nothing of it remains. The note it
    /// names is refused; the others wait to be repacked, unless the failure is a race.
    fn failed(
        &mut self,
        pending: &mut Vec<(usize, Job)>,
        packed: &Packed,
        error: &TransactionError,
        fallback: &str,
    ) -> Flow {
        let Some(index) = failing_note(packed, error) else {
            let why = if matches!(error, TransactionError::BlockhashNotFound) {
                "retry"
            } else {
                "failed"
            };
            for note in &packed.notes {
                self.refuse(*note, why);
                pending.retain(|(i, _)| i != note);
            }
            self.retry_rest(pending);
            return Flow::Stop;
        };
        let (why, race) = failure_reason(error, fallback);
        self.refuse(index, why);
        pending.retain(|(i, _)| *i != index);
        if race {
            self.retry_rest(pending);
            Flow::Stop
        } else {
            Flow::Continue
        }
    }
}

/// Sends the first transaction of what is pending, or refuses what cannot be sent.
async fn next(
    state: &Gateway,
    pending: &mut Vec<(usize, Job)>,
    answer: &mut Answer,
    sends: &mut usize,
) -> Result<Flow, Error> {
    let program = state.settings.program.id();
    let jobs: Vec<(usize, Vec<Instruction>)> = pending
        .iter()
        .map(|(index, job)| (*index, job.instructions.clone()))
        .collect();
    let packs = pack(&jobs, |instructions| fits(state, &program, instructions));
    let packed = &packs[0];
    let members: Vec<Member> = packed
        .notes
        .iter()
        .map(|note| {
            let job = &pending.iter().find(|(i, _)| i == note).unwrap().1;
            Member {
                request: job.request.clone(),
                priced: job.priced,
                lock: job.lock,
                verified: job.verified,
            }
        })
        .collect();

    let mut reservations: Vec<Reservation> = Vec::new();
    for (note, job) in packed.notes.iter().zip(&members) {
        match state
            .settlements
            .reserve_priced(job.request.clone(), job.priced)
        {
            Ok(reservation) => reservations.push(reservation),
            Err(refusal) => {
                answer.refuse(*note, reason(&limits(state, refusal, job.request.now)));
                pending.retain(|(i, _)| i != note);
                return Ok(Flow::Continue);
            }
        }
    }

    let fee_payer = state.fee_payer.pubkey();
    let ceiling = u32::try_from(members.len()).unwrap_or(u32::MAX) * COMPUTE_UNIT_CEILING;
    let (blockhash, _) = state
        .rpc
        .get_latest_blockhash_with_commitment(state.rpc.commitment())
        .await
        .map_err(unreachable)?;
    let mut written = vec![fee_payer];
    written.extend(members.iter().map(|job| job.lock));
    let recent = state
        .rpc
        .get_recent_prioritization_fees(&written)
        .await
        .map_err(unreachable)?;
    let price = priority_fee(
        recent.iter().map(|fee| fee.prioritization_fee).collect(),
        state.settings.max_priority_fee,
    );
    let priority = |limit: u32| price.saturating_mul(u64::from(limit)).div_ceil(1_000_000);
    let loaded = loaded_accounts_limit(loaded_accounts_size(state, &packed.instructions).await?);
    let draft = compose(
        state,
        &packed.instructions,
        blockhash,
        ceiling,
        loaded,
        priority(ceiling),
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
        warn!("a group transaction would fail");
        // Nothing was sent: the reservations are dropped with this call.
        return Ok(answer.failed(
            pending,
            packed,
            &TransactionError::from(failure),
            "rejected",
        ));
    }
    let used = simulation.units_consumed.unwrap_or(0);
    let limit = u32::try_from(used + used * 3 / 10)
        .unwrap_or(ceiling)
        .clamp(MIN_COMPUTE_UNIT_LIMIT, ceiling);
    let verified: u64 = members.iter().map(|job| job.verified).sum();
    let fee = SIGNATURE_FEE * (1 + verified) + priority(limit);
    let message = compose(
        state,
        &packed.instructions,
        blockhash,
        limit,
        loaded,
        priority(limit),
    )?;
    let transaction = VersionedTransaction {
        signatures: vec![state.fee_payer.sign_message(&message.serialize())],
        message,
    };

    // The bonds and the clock as they are now, then every reservation begins or none does.
    let mut keys = vec![CLOCK_SYSVAR];
    keys.extend(members.iter().map(|job| job.lock));
    let accounts = read(state, &keys).await?;
    let now = chain_now(&accounts[0])?;
    let bonds = accounts[1..]
        .iter()
        .map(|account| {
            account
                .as_ref()
                .and_then(|account| Lock::from_bytes(&account.data).ok())
                .map(|lock| lock.bond)
                .ok_or(Error::Upstream)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let slot = state.rpc.get_slot().await.map_err(unreachable)?;
    let sending = match state.settlements.begin_all(reservations, now, slot, &bonds) {
        Ok(sending) => sending,
        Err((position, refusal)) => {
            let note = packed.notes[position];
            answer.refuse(note, reason(&limits(state, refusal, now)));
            pending.retain(|(i, _)| *i != note);
            return Ok(Flow::Continue);
        }
    };

    *sends += 1;
    let signature = transaction.signatures[0];
    let listed = || (signature.to_string(), packed.notes.clone());
    let done = |pending: &mut Vec<(usize, Job)>| {
        pending.retain(|(i, _)| !packed.notes.contains(i));
    };
    match state.rpc.send_transaction(&transaction).await {
        Ok(_) => match confirmed(state, &signature).await {
            Confirmed::Landed => {
                let slot = state.rpc.get_slot().await.unwrap_or_default();
                finish(sending.landed(slot));
                answer.sent.push(listed());
                done(pending);
                Ok(Flow::Continue)
            }
            Confirmed::Failed(error) => {
                finish(sending.failed(fee));
                Ok(answer.failed(pending, packed, &error, "failed"))
            }
            Confirmed::Unknown => {
                warn!("Solana did not say whether it took a group transaction");
                finish(sending.unknown());
                answer.sent.push(listed());
                done(pending);
                Ok(Flow::Continue)
            }
        },
        Err(error) => match error.get_transaction_error() {
            Some(error) => {
                finish(sending.failed(0));
                Ok(answer.failed(pending, packed, &error, "failed"))
            }
            None => {
                warn!("Solana did not say whether it took a group transaction");
                finish(sending.unknown());
                answer.sent.push(listed());
                done(pending);
                Ok(Flow::Continue)
            }
        },
    }
}

async fn settle_group(state: &Gateway, prefix: Prefix, notes: &[SettlementRequest]) -> Answer {
    let mut answer = Answer::default();
    let mut guards = Vec::new();
    let mut pending: Vec<(usize, Job)> = Vec::new();
    let mut seen = HashSet::new();
    let mut over_budget = false;
    for (index, note) in notes.iter().enumerate() {
        // The first note is counted by the request itself, each other one counts once more.
        if index > 0 && !over_budget && state.requests.check(prefix).is_err() {
            over_budget = true;
        }
        if over_budget {
            answer.refuse(index, "retry");
            continue;
        }
        let key = job_key(note);
        if !seen.insert(key.clone()) {
            answer.refuse(index, "duplicate");
            continue;
        }
        let Some(driving) = state.jobs.drive(&key) else {
            answer.refuse(index, "busy");
            continue;
        };
        match inspect_settlement(state, prefix, note).await {
            Ok(Planned::Settled) => answer.refuse(index, "settled"),
            Ok(Planned::Send(job)) if job.remaining > 1 => answer.refuse(index, "multi_batch"),
            Ok(Planned::Send(job)) => {
                guards.push(driving);
                pending.push((index, *job));
            }
            Err(error) => answer.refuse(index, reason(&error)),
        }
    }

    let mut sends = 0;
    while !pending.is_empty() && sends <= MAX_GROUP {
        match next(state, &mut pending, &mut answer, &mut sends).await {
            Ok(Flow::Continue) => {}
            Ok(Flow::Stop) => break,
            Err(error) => {
                let why = reason(&error);
                for (index, _) in pending.drain(..) {
                    answer.refuse(index, why.clone());
                }
            }
        }
    }
    answer.retry_rest(&mut pending);
    drop(guards);
    answer
}

pub(crate) async fn post(
    State(state): State<Arc<Gateway>>,
    Extension(Client(ip)): Extension<Client>,
    Json(request): Json<GroupRequest>,
) -> Result<Json<serde_json::Value>, Error> {
    if request.settlements.is_empty() || request.settlements.len() > MAX_GROUP {
        return Err(Error::BadRequest("a group holds one to eight settlements"));
    }
    let answer = settle_group(&state, ip.into(), &request.settlements).await;
    info!(
        notes = request.settlements.len(),
        transactions = answer.sent.len(),
        refused = answer.refused.len(),
        "group settlement answered"
    );
    Ok(Json(json!({
        "transactions": answer.sent.iter()
            .map(|(signature, indexes)| json!({ "signature": signature, "indexes": indexes }))
            .collect::<Vec<_>>(),
        "refused": answer.refused.iter()
            .map(|(index, reason)| json!({ "index": index, "reason": reason }))
            .collect::<Vec<_>>(),
    })))
}
#[cfg(test)]
mod tests {
    use super::*;
    use solana_instruction::{Instruction, error::InstructionError};
    use solana_pubkey::Pubkey;

    fn ix(tag: u8) -> Instruction {
        Instruction {
            program_id: Pubkey::new_from_array([tag; 32]),
            accounts: vec![],
            data: vec![tag],
        }
    }

    #[test]
    fn pack_is_greedy_in_request_order() {
        let jobs: Vec<(usize, Vec<Instruction>)> = (0..5)
            .map(|i| (i, vec![ix(i as u8), ix(i as u8)]))
            .collect();
        let packs = pack(&jobs, |ixs| ixs.len() <= 4);
        let notes: Vec<Vec<usize>> = packs.iter().map(|p| p.notes.clone()).collect();
        assert_eq!(notes, vec![vec![0, 1], vec![2, 3], vec![4]]);
        assert_eq!(packs[1].owner, vec![2, 2, 3, 3]);
    }

    #[test]
    fn failing_instruction_maps_to_its_note() {
        let jobs: Vec<(usize, Vec<Instruction>)> =
            [3, 5, 6].iter().map(|&i| (i, vec![ix(1), ix(2)])).collect();
        let p = &pack(&jobs, |_| true)[0];
        let at = |k: u8| TransactionError::InstructionError(k, InstructionError::Custom(6001));
        assert_eq!(failing_note(p, &at(0)), Some(3));
        assert_eq!(failing_note(p, &at(3)), Some(5));
        assert_eq!(failing_note(p, &at(5)), Some(6));
        assert_eq!(failing_note(p, &at(6)), None);
        assert_eq!(failing_note(p, &TransactionError::AccountInUse), None);
    }
}
