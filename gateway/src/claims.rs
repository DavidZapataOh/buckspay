//! Sponsored filing of a loss. A payment that cannot be settled, because another message was
//! recorded for the output it consumed or because the issuer's backing cannot pay it, burns twice
//! its amount out of the lock that backed it. Nobody signs a claim and nobody is paid: the gateway
//! pays the fee and fronts the rent of the claim account, and the janitor takes the rent back when
//! the claim can be closed.
//!
//! The program is the judge. The gateway only decides which claim to try, builds it and sends it
//! when a simulation says it lands.
use crate::{
    batches::{RECLAIMED, RecordView, recorded_prefix},
    chain::SIGNATURE_FEE,
    fees::priority_fee,
    janitor,
    onboard::read,
    server::{Error, Gateway},
    settlements::{
        COMPUTE_UNIT_CEILING, MIN_COMPUTE_UNIT_LIMIT, Problem, SettlementRequest, Walk, compose,
        loaded_accounts_limit, loaded_accounts_size, parse_issue, parse_spends, record_view, walk,
    },
    sponsored::{Outcome, confirm, unreachable},
    transactions::{self, Filing},
};
use axum::{Json, extract::State};
use buckspay_client::errors::BuckspayError;
use buckspay_protocol::{
    Issue, Owner, Signed, Spend, chain as rules,
    hash::{domain, purpose},
    record::{self, RecordRef, first_conflict},
    secp256r1::MAX_SIGNATURES,
    verify::verify_signature,
};
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_instruction::Instruction;
use solana_instruction_error::InstructionError;
use solana_pubkey::Pubkey;
use solana_rpc_client_api::config::RpcSimulateTransactionConfig;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction_error::TransactionError;
use std::sync::Arc;
use tracing::{info, warn};

/// A claim account: its discriminator, lock, amount, burn, payer and the time it may close.
pub const CLAIM_LEN: u64 = 92;
/// Where the payer is in a claim, for the janitor's search of what the gateway paid for.
pub const CLAIM_PAYER_OFFSET: usize = 56;
/// Where the time a claim may be closed is in a claim.
pub const CLAIM_CLOSABLE_OFFSET: usize = 88;
/// Where the amount a claim burned is in a claim.
pub const CLAIM_BURN_OFFSET: usize = 48;

/// The first eight bytes of a claim: Anchor's discriminator of the account `Claim`.
pub fn claim_discriminator() -> [u8; 8] {
    Sha256::digest(b"account:Claim")[..8].try_into().unwrap()
}

/// Whom a claim names, said only once the program accepts the claim.
struct Report {
    /// The index of the culprit's spend; `None` when the culprit is the issuer.
    hop: Option<u8>,
    culprit: [u8; 33],
    lock: Pubkey,
}

/// One claim the program may take, with the accounts that name it.
struct Candidate {
    instructions: Vec<Instruction>,
    claim: Pubkey,
    /// Signatures the transaction's fee counts besides its own.
    verified: u64,
    report: Report,
}

fn claim_address(program: &Pubkey, output: &[u8; 32]) -> Result<Pubkey, Problem> {
    record::claim_address(&program.to_bytes(), output)
        .map(Pubkey::new_from_array)
        .ok_or(Problem::Invalid("an output of the chain cannot be claimed"))
}

/// The claims the chain can support, most specific first: for every output a recorded message
/// contradicts, the loss of the payment its spender made of it, and last the loss of an issue the
/// backing cannot pay. The program refuses the ones that are not claims.
async fn candidates(state: &Gateway, request: &SettlementRequest) -> Result<Vec<Candidate>, Error> {
    let program = state.settings.program;
    let note_domain = domain(
        purpose::NOTE,
        &state.settings.genesis_hash,
        &program.id().to_bytes(),
    );
    let issue = parse_issue(&request.issue)?;
    let spends = parse_spends(&request.spends)?;
    let chain = walk(&program.id(), &note_domain, &issue, &spends)?;
    if chain.issue.mint != state.settings.mint.to_bytes() {
        return Err(Problem::Invalid("the note is not of the mint the gateway sponsors").into());
    }
    let records: Vec<Pubkey> = chain
        .consumed
        .iter()
        .map(|c| {
            record::address(&program.id().to_bytes(), &c.output)
                .map(Pubkey::new_from_array)
                .ok_or(Problem::Invalid(
                    "an output of the chain cannot be recorded",
                ))
        })
        .collect::<Result<_, _>>()?;
    let accounts = read(state, &records).await?;
    let token_program = read(state, &[state.settings.mint])
        .await?
        .remove(0)
        .map(|mint| mint.owner)
        .ok_or(Problem::Lock("no_mint"))?;

    let views: Vec<Option<RecordView>> = accounts
        .into_iter()
        .map(|account| record_view(&program.id(), account))
        .collect();
    let contents: Vec<[u8; 32]> = chain.consumed.iter().map(|c| c.content).collect();
    let recorded: Vec<Option<RecordRef>> = views
        .iter()
        .map(|view| {
            view.map(|view| RecordRef {
                content: view.content,
                reclaimed: view.flags & RECLAIMED != 0,
            })
        })
        .collect();
    let mut found = Vec::new();
    if let Some(hop) = first_conflict(&contents, &recorded) {
        let at = Spot {
            hop,
            record: records[hop],
            token_program,
        };
        found.extend(lost_spend(state, &note_domain, &issue, &spends, &at)?);
    }
    found.extend(unbacked(
        state,
        &program.id(),
        &chain,
        &views,
        token_program,
    )?);
    Ok(found)
}

/// Where a chain first meets a record that contradicts it.
struct Spot {
    hop: usize,
    record: Pubkey,
    token_program: Pubkey,
}

/// The claim of the loss of the culprit's payment at `at.hop`: output 0 of that spend, in the chain
/// that ends there. Only a spend its signer signed names a culprit, so a body nobody signed, which
/// a chain refused early could carry, names nobody.
fn lost_spend(
    state: &Gateway,
    note_domain: &[u8; 32],
    issue: &Signed<Issue>,
    spends: &[Signed<Spend>],
    at: &Spot,
) -> Result<Option<Candidate>, Error> {
    let program = state.settings.program;
    let i = at.hop;
    let prefix = walk(&program.id(), note_domain, issue, &spends[..=i])?;
    let (culprit, envelope, signature) = prefix.entries[i + 1];
    if verify_signature(&culprit, &envelope, &signature).is_err() {
        return Ok(None);
    }
    let earlier: Vec<([u8; 33], u32)> = prefix.entries[1..=i]
        .iter()
        .zip(spends)
        .map(|(entry, spend)| (entry.0, spend.message.lock_seq))
        .collect();
    let Some((lock_key, lock_seq)) = rules::backer(
        &prefix.issue.issuer,
        prefix.issue.lock_seq,
        &earlier,
        &culprit,
        spends[i].message.lock_seq,
        prefix.consumed[i].unlocked,
    ) else {
        return Ok(None);
    };
    let payment = prefix.last.first;
    if payment.owner == Owner::Device(culprit) {
        return Ok(None);
    }
    let Ok(claim) = claim_address(&program.id(), &payment.id) else {
        return Ok(None);
    };
    let lock = program.find_lock_pda(&lock_key, lock_seq).0;
    let filing = Filing {
        payer: state.fee_payer.pubkey(),
        lock,
        mint: state.settings.mint,
        token_program: at.token_program,
        claim,
        record: at.record,
    };
    let verification = transactions::chain_verification(&[(culprit, envelope)], &[signature])
        .ok_or(Problem::Invalid(
            "the culprit's signature does not fit a verification",
        ))?;
    Ok(Some(Candidate {
        instructions: vec![
            verification,
            transactions::claim_lost_spend(
                &program,
                &filing,
                prefix.issue_body,
                prefix.links,
                lock_key,
                lock_seq,
            ),
        ],
        claim,
        verified: 1,
        report: Report {
            hop: Some(u8::try_from(i).expect("a chain has at most 16 spends")),
            culprit,
            lock,
        },
    }))
}

/// The claim of the last output of a chain whose issuer's backing cannot pay it. The records that
/// vouch for its first messages spare their signatures; more than eight left to verify wait for the
/// records of the rest.
fn unbacked(
    state: &Gateway,
    program_id: &Pubkey,
    chain: &Walk,
    views: &[Option<RecordView>],
    token_program: Pubkey,
) -> Result<Option<Candidate>, Error> {
    let vouched = if chain.consumed.is_empty() {
        0
    } else {
        recorded_prefix(&chain.consumed, views)
    };
    if chain.entries.len().saturating_sub(vouched) > MAX_SIGNATURES {
        return Ok(None);
    }
    let payment = chain.last.first;
    let Ok(claim) = claim_address(program_id, &payment.id) else {
        return Ok(None);
    };
    let outputs: Vec<[u8; 32]> = match payment.owner {
        Owner::Account(_) if chain.consumed.is_empty() => vec![payment.id],
        _ => chain.consumed.iter().map(|c| c.output).collect(),
    };
    let records = outputs
        .iter()
        .map(|output| {
            record::address(&program_id.to_bytes(), output)
                .map(Pubkey::new_from_array)
                .ok_or(Problem::Invalid(
                    "an output of the chain cannot be recorded",
                ))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let record = record::address(&program_id.to_bytes(), &payment.id)
        .map(Pubkey::new_from_array)
        .ok_or(Problem::Invalid(
            "an output of the chain cannot be recorded",
        ))?;
    let lock = state
        .settings
        .program
        .find_lock_pda(&chain.issue.issuer, chain.issue.lock_seq)
        .0;
    let filing = Filing {
        payer: state.fee_payer.pubkey(),
        lock,
        mint: state.settings.mint,
        token_program,
        claim,
        record,
    };
    let unvouched = &chain.entries[vouched.min(chain.entries.len())..];
    let signatures: Vec<[u8; 64]> = unvouched.iter().map(|entry| entry.2).collect();
    let entries: Vec<_> = unvouched.iter().map(|entry| (entry.0, entry.1)).collect();
    let mut instructions = Vec::with_capacity(2);
    if !entries.is_empty() {
        instructions.push(
            transactions::chain_verification(&entries, &signatures)
                .ok_or(Problem::Invalid("the chain does not fit one verification"))?,
        );
    }
    instructions.push(transactions::claim_unbacked(
        &state.settings.program,
        &filing,
        chain.issue_body,
        chain.links.clone(),
        &records,
    ));
    Ok(Some(Candidate {
        instructions,
        claim,
        verified: signatures.len() as u64,
        report: Report {
            hop: None,
            culprit: chain.issue.issuer,
            lock,
        },
    }))
}

/// What the program said of a claim that did not land, as the name the app reads.
fn refusal(failure: &TransactionError) -> Option<&'static str> {
    let TransactionError::InstructionError(_, InstructionError::Custom(code)) = failure else {
        return None;
    };
    let is = |error: BuckspayError| *code == error as u32;
    Some(if is(BuckspayError::NoBond) {
        "no_bond"
    } else if is(BuckspayError::OverCoverage) {
        "over_coverage"
    } else if is(BuckspayError::ClaimTooLate) {
        "claim_too_late"
    } else if is(BuckspayError::LockEnded) {
        "lock_ended"
    } else if is(BuckspayError::AlreadyClaimed) {
        "claimed"
    } else if [
        BuckspayError::NotClaimable,
        BuckspayError::NotConflicting,
        BuckspayError::ConflictProof,
        BuckspayError::NoRecord,
        BuckspayError::WrongLock,
    ]
    .into_iter()
    .any(is)
    {
        "not_claimable"
    } else {
        return None;
    })
}

/// What a claim simulated to: the compute units it takes, or why the program refuses it.
enum Simulated {
    Lands(u64),
    Refused(Option<&'static str>),
}

async fn simulate(
    state: &Gateway,
    instructions: &[Instruction],
    loaded: u32,
) -> Result<Simulated, Error> {
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
        loaded,
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
    Ok(match simulation.err {
        None => Simulated::Lands(simulation.units_consumed.unwrap_or(0)),
        Some(failure) => Simulated::Refused(refusal(&TransactionError::from(failure))),
    })
}

/// Sends the claim, as the fee payer and the program's payer, and waits for its outcome.
async fn send(
    state: &Gateway,
    candidate: &Candidate,
    units: u64,
    loaded: u32,
) -> Result<Signature, Error> {
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
    let limit = u32::try_from(units + units * 3 / 10)
        .unwrap_or(COMPUTE_UNIT_CEILING)
        .clamp(MIN_COMPUTE_UNIT_LIMIT, COMPUTE_UNIT_CEILING);
    let priority = price.saturating_mul(u64::from(limit)).div_ceil(1_000_000);
    let message = compose(
        state,
        &candidate.instructions,
        blockhash,
        limit,
        loaded,
        priority,
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
                warn!("a claim failed its preflight");
                Error::Rejected
            } else {
                warn!("Solana did not say whether it took a claim");
                Error::Upstream
            }
        })?;
    info!(%signature, fee = SIGNATURE_FEE * (1 + candidate.verified) + priority, "claim sent");
    match confirm(state, &signature).await {
        Outcome::Landed => Ok(signature),
        Outcome::FailedOnChain => Err(Error::Failed),
        Outcome::Unknown => Err(Error::Upstream),
    }
}

/// What the gateway says of a loss: whom it names and what burned. `hop` and `culprit` are said
/// only for a claim the program accepted or refused for its deadline or for being filed already,
/// after it verified the culprit's signature.
fn answer(
    report: &Report,
    state: &str,
    signature: Option<Signature>,
    burned: Option<u64>,
) -> serde_json::Value {
    serde_json::json!({
        "state": state,
        "hop": report.hop,
        "culprit": hex::encode(report.culprit),
        "lock": report.lock.to_string(),
        "burned": burned.map(|burned| burned.to_string()),
        "signature": signature.map(|signature| signature.to_string()),
    })
}

/// What a claim account says was burned.
async fn burned(state: &Gateway, claim: &Pubkey) -> Result<Option<u64>, Error> {
    let accounts: Vec<Option<Account>> = read(state, &[*claim]).await?;
    Ok(accounts.into_iter().next().flatten().and_then(|account| {
        (account.data.len() as u64 == CLAIM_LEN).then(|| {
            u64::from_le_bytes(
                account.data[CLAIM_BURN_OFFSET..CLAIM_BURN_OFFSET + 8]
                    .try_into()
                    .unwrap(),
            )
        })
    }))
}

/// Files the loss the chain proves, if any claim of it lands, and says whom it names: `filed`
/// when this call filed it, `already` when it was filed before, `late` when its deadline passed.
pub async fn file(
    state: &Gateway,
    request: &SettlementRequest,
) -> Result<serde_json::Value, Error> {
    let candidates = candidates(state, request).await?;
    let mut said = None;
    let mut late = None;
    // Claims are filed one at a time so that the cap on what the gateway fronts holds exactly.
    let _filing = state.claiming.lock().await;
    for candidate in &candidates {
        let loaded =
            loaded_accounts_limit(loaded_accounts_size(state, &candidate.instructions).await?);
        match simulate(state, &candidate.instructions, loaded).await? {
            Simulated::Lands(units) => {
                let rent = state.rents().claim;
                if (janitor::open_claims(state).await?.len() as u64 + 1) * rent
                    > state.settings.claim_float_cap
                {
                    return Err(Problem::Limits(crate::float::Refusal::FloatCap, None).into());
                }
                let signature = send(state, candidate, units, loaded).await?;
                let burned = burned(state, &candidate.claim).await?;
                return Ok(answer(&candidate.report, "filed", Some(signature), burned));
            }
            Simulated::Refused(Some("claimed")) => {
                let burned = burned(state, &candidate.claim).await?;
                return Ok(answer(&candidate.report, "already", None, burned));
            }
            Simulated::Refused(Some("claim_too_late")) => {
                late = late.or(Some(&candidate.report));
            }
            Simulated::Refused(name) => said = said.or(name),
        }
    }
    if let Some(report) = late {
        return Ok(answer(report, "late", None, None));
    }
    Err(Problem::Claim(said.unwrap_or("not_claimable")).into())
}

pub(crate) async fn claim(
    State(state): State<Arc<Gateway>>,
    Json(request): Json<SettlementRequest>,
) -> Result<Json<serde_json::Value>, Error> {
    file(&state, &request).await.map(Json)
}

/// Files in the background what a settlement that passed through the gateway proves, without
/// being asked: a victim's own attempt to settle is the evidence, and nothing is paid for
/// filing, so nothing needs the victim's help.
pub fn file_in_background(state: Arc<Gateway>, request: SettlementRequest) {
    tokio::spawn(async move {
        match file(&state, &request).await {
            Ok(answer) => info!(%answer, "a claim was filed for a settlement that failed"),
            Err(_) => warn!("a settlement that failed could not be claimed"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use buckspay_client::errors::BuckspayError as E;

    fn custom(error: E) -> TransactionError {
        TransactionError::InstructionError(0, InstructionError::Custom(error as u32))
    }

    #[test]
    fn what_the_program_says_is_what_the_app_reads() {
        assert_eq!(refusal(&custom(E::NoBond)), Some("no_bond"));
        assert_eq!(refusal(&custom(E::OverCoverage)), Some("over_coverage"));
        assert_eq!(refusal(&custom(E::AlreadyClaimed)), Some("claimed"));
        assert_eq!(refusal(&custom(E::NotConflicting)), Some("not_claimable"));
        assert_eq!(refusal(&custom(E::AmountZero)), None);
        assert_eq!(refusal(&TransactionError::AccountNotFound), None);
    }

    fn report() -> Report {
        Report {
            hop: Some(2),
            culprit: [2; 33],
            lock: Pubkey::new_unique(),
        }
    }

    #[test]
    fn a_late_claim_names_the_culprit_and_burns_nothing() {
        let said = answer(&report(), "late", None, None);
        assert_eq!(said["state"], "late");
        assert_eq!(said["hop"], 2);
        assert_eq!(said["culprit"], hex::encode([2u8; 33]));
        assert!(said["burned"].is_null() && said["signature"].is_null());
    }

    #[test]
    fn a_filed_claim_says_the_burn_as_a_decimal_string_and_an_issuer_has_no_hop() {
        let issuer = Report {
            hop: None,
            ..report()
        };
        let said = answer(
            &issuer,
            "filed",
            Some(Signature::default()),
            Some(80_000_000),
        );
        assert_eq!(said["burned"], "80000000");
        assert!(said["hop"].is_null());
        assert!(said["signature"].is_string());
    }

    #[test]
    fn a_claim_account_has_the_size_the_program_gives_it() {
        assert_eq!(CLAIM_BURN_OFFSET + 8, CLAIM_PAYER_OFFSET);
        assert_eq!(CLAIM_LEN, 92);
        assert_eq!(CLAIM_PAYER_OFFSET + 32, CLAIM_CLOSABLE_OFFSET);
        assert_eq!(CLAIM_CLOSABLE_OFFSET + 4, CLAIM_LEN as usize);
    }
}
