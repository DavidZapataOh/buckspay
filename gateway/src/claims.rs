//! Sponsored filing of a loss. A payment that cannot be settled, because another message was
//! recorded for the output it consumed or because the issuer's backing cannot pay it, burns twice
//! its amount out of the lock that backed it. Nobody signs a claim and nobody is paid: the gateway
//! pays the fee and fronts the rent of the claim account, and the janitor takes the rent back when
//! the claim can be closed.
//!
//! The program is the judge. The gateway only decides which claim to try, builds it and sends it
//! when a simulation says it lands.
use crate::{
    chain::SIGNATURE_FEE,
    fees::priority_fee,
    janitor,
    onboard::read,
    server::{Error, Gateway},
    settlements::{
        COMPUTE_UNIT_CEILING, MIN_COMPUTE_UNIT_LIMIT, Problem, RECORD_LEN, SettlementRequest, Walk,
        compose, loaded_accounts_limit, loaded_accounts_size, parse_issue, parse_spends, walk,
    },
    sponsored::{Outcome, confirm, unreachable},
    transactions::{self, Filing},
};
use axum::{Json, extract::State};
use buckspay_client::errors::BuckspayError;
use buckspay_protocol::{
    Owner, chain as rules,
    hash::{domain, purpose},
    record,
    secp256r1::MAX_SIGNATURES,
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

/// The first eight bytes of a claim: Anchor's discriminator of the account `Claim`.
pub fn claim_discriminator() -> [u8; 8] {
    Sha256::digest(b"account:Claim")[..8].try_into().unwrap()
}

/// One claim the program may take, with the accounts that name it.
struct Candidate {
    instructions: Vec<Instruction>,
    claim: Pubkey,
    /// Signatures the transaction's fee counts besides its own.
    verified: u64,
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

    let mut found = Vec::new();
    for (i, account) in accounts.iter().enumerate() {
        let contradicted = account.as_ref().is_some_and(|account| {
            account.owner == program.id()
                && account.data.len() as u64 == RECORD_LEN
                && account.data[8..40] != chain.consumed[i].content
        });
        if !contradicted {
            continue;
        }
        // The loss is the culprit's payment: output 0 of spend `i`, in the chain that ends there.
        let prefix = walk(&program.id(), &note_domain, &issue, &spends[..=i])?;
        let earlier: Vec<([u8; 33], u32)> = prefix.entries[1..=i]
            .iter()
            .zip(&spends)
            .map(|(entry, spend)| (entry.0, spend.message.lock_seq))
            .collect();
        let culprit = prefix.entries[i + 1].0;
        let Some((lock_key, lock_seq)) = rules::backer(
            &prefix.issue.issuer,
            prefix.issue.lock_seq,
            &earlier,
            &culprit,
            spends[i].message.lock_seq,
            prefix.consumed[i].unlocked,
        ) else {
            continue;
        };
        let payment = prefix.last.first;
        if payment.owner == Owner::Device(culprit) {
            continue;
        }
        let Ok(claim) = claim_address(&program.id(), &payment.id) else {
            continue;
        };
        let lock = program.find_lock_pda(&lock_key, lock_seq).0;
        let filing = Filing {
            payer: state.fee_payer.pubkey(),
            lock,
            mint: state.settings.mint,
            token_program,
            claim,
            record: records[i],
        };
        let signature = [prefix.entries[i + 1].2];
        let verification = transactions::chain_verification(
            &[(prefix.entries[i + 1].0, prefix.entries[i + 1].1)],
            &signature,
        )
        .ok_or(Problem::Invalid(
            "the chain is too long for one verification",
        ))?;
        found.push(Candidate {
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
        });
    }
    found.extend(unbacked(state, &program.id(), &chain, token_program)?);
    Ok(found)
}

/// The claim of the last output of a chain whose issuer's backing cannot pay it.
fn unbacked(
    state: &Gateway,
    program_id: &Pubkey,
    chain: &Walk,
    token_program: Pubkey,
) -> Result<Option<Candidate>, Error> {
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
    let signatures: Vec<[u8; 64]> = chain.entries.iter().map(|entry| entry.2).collect();
    let entries: Vec<_> = chain
        .entries
        .iter()
        .map(|entry| (entry.0, entry.1))
        .collect();
    let verification = transactions::chain_verification(&entries, &signatures).ok_or(
        Problem::Invalid("the chain is too long for one verification"),
    )?;
    debug_assert!(signatures.len() <= MAX_SIGNATURES);
    Ok(Some(Candidate {
        instructions: vec![
            verification,
            transactions::claim_unbacked(
                &state.settings.program,
                &filing,
                chain.issue_body,
                chain.links.clone(),
                &records,
            ),
        ],
        claim,
        verified: signatures.len() as u64,
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

/// Files the loss the chain proves, if any claim of it lands: the answer is the signature of the
/// transaction, or `claimed` when the loss was claimed already.
pub async fn file(
    state: &Gateway,
    request: &SettlementRequest,
) -> Result<serde_json::Value, Error> {
    let candidates = candidates(state, request).await?;
    let mut said = None;
    // Claims are filed one at a time so that the cap on what the gateway fronts holds exactly.
    let _filing = state.claiming.lock().await;
    for candidate in &candidates {
        let accounts: Vec<Option<Account>> = read(state, &[candidate.claim]).await?;
        if accounts[0]
            .as_ref()
            .is_some_and(|a| a.data.len() as u64 == CLAIM_LEN)
        {
            return Ok(serde_json::json!({ "status": "claimed" }));
        }
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
                return Ok(serde_json::json!({ "signature": signature.to_string() }));
            }
            Simulated::Refused(Some("claimed")) => {
                return Ok(serde_json::json!({ "status": "claimed" }));
            }
            Simulated::Refused(name) => said = said.or(name),
        }
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

    #[test]
    fn a_claim_account_has_the_size_the_program_gives_it() {
        assert_eq!(CLAIM_LEN, 92);
        assert_eq!(CLAIM_PAYER_OFFSET + 32, CLAIM_CLOSABLE_OFFSET);
        assert_eq!(CLAIM_CLOSABLE_OFFSET + 4, CLAIM_LEN as usize);
    }
}
