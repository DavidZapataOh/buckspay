//! What every sponsored transaction shares: it is prepared for a wallet to sign, held until the
//! wallet returns it signed, and sent only if it is byte for byte what was prepared. The gateway
//! signs last, as fee payer, so it signs nothing it did not build.
use crate::{
    chain::SIGNATURE_FEE,
    fees::priority_fee,
    server::{Error, Gateway},
    sponsor::Reservation,
    transactions,
};
use axum::{Json, extract::State};
use base64::{Engine, prelude::BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use solana_instruction::Instruction;
use solana_message::VersionedMessage;
use solana_pubkey::Pubkey;
use solana_rpc_client_api::config::RpcSimulateTransactionConfig;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction_error::TransactionError;
use solana_transaction_status_client_types::TransactionConfirmationStatus;
use std::{
    sync::{Arc, MutexGuard},
    time::{Duration, Instant},
};
use tracing::{error, info, warn};

/// How long a prepared registration waits for the wallet's signature, in the binary.
pub const PENDING_TTL: Duration = Duration::from_secs(90);
/// How long a sent transaction is waited for before its outcome is called unknown.
pub const CONFIRM_TIMEOUT: Duration = Duration::from_secs(30);
/// The least a transaction's compute unit limit is, whatever its simulation used.
const MIN_COMPUTE_UNIT_LIMIT: u32 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Onboard,
    Lock,
    Withdrawal,
    RotationRequest,
    RotationCancel,
}

pub(crate) struct Pending {
    pub(crate) op: Op,
    /// The wallet that signs besides the fee payer.
    pub(crate) signer: Pubkey,
    pub(crate) message: VersionedMessage,
    pub(crate) bytes: Vec<u8>,
    pub(crate) expires: Instant,
    /// The caps it holds against the network that prepared it, until it is sent or dropped.
    pub(crate) reservation: Option<Reservation>,
    /// Lamports of transaction fees the sponsor pays if it lands, whatever it does.
    pub(crate) fee: u64,
}

/// The prepared transactions, after dropping the expired ones and so releasing their reservations.
pub(crate) fn live(
    state: &Gateway,
) -> MutexGuard<'_, std::collections::HashMap<[u8; 33], Pending>> {
    let mut pending = state.pending.lock().unwrap();
    let now = Instant::now();
    pending.retain(|_, entry| entry.expires > now);
    pending
}

/// A transaction to prepare, once the request is checked and the caps hold a place for it.
pub(crate) struct Draft {
    pub(crate) op: Op,
    pub(crate) key: [u8; 33],
    /// The wallet that signs besides the fee payer.
    pub(crate) signer: Pubkey,
    pub(crate) instructions: Vec<Instruction>,
    /// Accounts the transaction writes, for pricing it against recent fees.
    pub(crate) writable: Vec<Pubkey>,
    pub(crate) reservation: Option<Reservation>,
    /// The fee the transaction pays the sponsor, in the mint's base units.
    pub(crate) sponsor_fee: u64,
    /// Lamports the fee payer needs for this transaction: rents it lends or spends, and fees.
    pub(crate) cost: u64,
    /// The most compute units it may be given.
    pub(crate) compute_unit_ceiling: u32,
    /// Signatures the sponsor's fee counts: the transaction's, and the secp256r1 verification's.
    pub(crate) signatures: u64,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrepareResponse {
    /// The unsigned transaction, base64: the fee payer's and the wallet's signatures are empty.
    pub transaction: String,
    pub fee_payer: String,
    pub blockhash: String,
    pub compute_unit_limit: u32,
    pub compute_unit_price: u64,
    /// The fee the transaction pays the sponsor in base units of the mint, as a decimal string.
    pub sponsor_fee: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmitRequest {
    pub key: String,
    /// The prepared transaction with the wallet's signature, base64.
    pub transaction: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SubmitResponse {
    pub signature: String,
}

pub(crate) fn hex_array<const N: usize>(value: &str) -> Option<[u8; N]> {
    hex::decode(value).ok()?.try_into().ok()
}

/// The wire format of a transaction with fewer than 128 signatures: their count, the signatures
/// and the message.
pub fn wire_transaction(transaction: &VersionedTransaction) -> Vec<u8> {
    let mut wire = vec![transaction.signatures.len() as u8];
    for signature in &transaction.signatures {
        wire.extend_from_slice(signature.as_ref());
    }
    wire.extend_from_slice(&transaction.message.serialize());
    wire
}

/// The RPC's errors carry its URL, which may hold an API key: neither is logged or returned.
pub(crate) fn unreachable<E>(_: E) -> Error {
    warn!("Solana is unreachable");
    Error::Upstream
}

/// Prices, simulates and stores a draft, and answers with the transaction to sign.
pub(crate) async fn finalize(
    state: &Gateway,
    draft: Draft,
) -> Result<Json<PrepareResponse>, Error> {
    let fee_payer = state.fee_payer.pubkey();
    let (blockhash, _) = state
        .rpc
        .get_latest_blockhash_with_commitment(state.rpc.commitment())
        .await
        .map_err(unreachable)?;
    let mut priced = vec![fee_payer];
    priced.extend(&draft.writable);
    let recent = state
        .rpc
        .get_recent_prioritization_fees(&priced)
        .await
        .map_err(unreachable)?;
    let price = priority_fee(
        recent.iter().map(|fee| fee.prioritization_fee).collect(),
        state.settings.max_priority_fee,
    );

    // Enough for every transaction being prepared, this one included.
    let priority = price
        .saturating_mul(u64::from(draft.compute_unit_ceiling))
        .div_ceil(1_000_000);
    let cost = draft.cost.saturating_add(priority);
    let balance = state
        .rpc
        .get_balance(&fee_payer)
        .await
        .map_err(unreachable)?;
    if balance < cost.saturating_mul(u64::from(state.sponsor.preparing()).max(1)) {
        warn!("the fee payer cannot pay for the transactions being prepared");
        return Err(Error::Unfunded);
    }

    // The limit is what the transaction uses in a simulation plus a fifth, never a constant: the
    // bump search of every account it creates costs what its address makes it cost.
    let simulated = transactions::compose(
        &fee_payer,
        draft.compute_unit_ceiling,
        price,
        &draft.instructions,
        blockhash,
    );
    let unsigned = VersionedTransaction {
        signatures: vec![Signature::default(); 2],
        message: simulated,
    };
    let simulation = state
        .rpc
        .simulate_transaction_with_config(
            &unsigned,
            RpcSimulateTransactionConfig {
                sig_verify: false,
                commitment: Some(state.rpc.commitment()),
                ..RpcSimulateTransactionConfig::default()
            },
        )
        .await
        .map_err(unreachable)?
        .value;
    if let Some(error) = simulation.err {
        warn!(%error, "a sponsored transaction would fail");
        return Err(Error::Rejected);
    }
    let used = simulation.units_consumed.unwrap_or(0);
    let limit = u32::try_from(used.saturating_add(used / 5))
        .unwrap_or(u32::MAX)
        .clamp(MIN_COMPUTE_UNIT_LIMIT, draft.compute_unit_ceiling);
    let message = transactions::compose(&fee_payer, limit, price, &draft.instructions, blockhash);

    let transaction = VersionedTransaction {
        signatures: vec![Signature::default(); 2],
        message: message.clone(),
    };
    let wire = wire_transaction(&transaction);
    let mut pending = live(state);
    if pending
        .get(&draft.key)
        .is_some_and(|entry| entry.signer != draft.signer)
    {
        return Err(Error::Conflict(
            "this key has a transaction being prepared for another wallet",
        ));
    }
    pending.insert(
        draft.key,
        Pending {
            op: draft.op,
            signer: draft.signer,
            bytes: message.serialize(),
            message,
            expires: Instant::now() + state.settings.pending_ttl,
            reservation: draft.reservation,
            fee: SIGNATURE_FEE * draft.signatures
                + price.saturating_mul(u64::from(limit)).div_ceil(1_000_000),
        },
    );
    Ok(Json(PrepareResponse {
        transaction: BASE64_STANDARD.encode(wire),
        fee_payer: fee_payer.to_string(),
        blockhash: blockhash.to_string(),
        compute_unit_limit: limit,
        compute_unit_price: price,
        sponsor_fee: draft.sponsor_fee.to_string(),
    }))
}

/// What Solana reported about a sent transaction.
#[derive(Debug, PartialEq)]
pub(crate) enum Outcome {
    /// Landed and succeeded.
    Landed,
    /// Landed and failed: the sponsor paid the fee and nothing opened.
    FailedOnChain,
    /// Neither a success nor a failure was reported: it may still land.
    Unknown,
}

/// Settles the reservation of a sent transaction by what Solana reported. `None` if it landed;
/// otherwise the answer to give.
pub(crate) fn settle(
    reservation: Option<Reservation>,
    outcome: Outcome,
    fee: u64,
) -> Option<Error> {
    let record = |result: std::io::Result<()>| {
        if let Err(error) = result {
            error!(%error, "the sponsorship ledger could not be written; sponsoring stopped");
        }
    };
    match outcome {
        Outcome::Landed => {
            if let Some(r) = reservation {
                record(r.commit());
            }
            None
        }
        Outcome::FailedOnChain => {
            if let Some(r) = reservation {
                record(r.failed(fee));
            }
            Some(Error::Failed)
        }
        Outcome::Unknown => {
            // It may still land, so it is counted as sent.
            if let Some(r) = reservation {
                record(r.unknown());
            }
            Some(Error::Upstream)
        }
    }
}

/// Waits for `signature` to reach `confirmed` or fail, up to the gateway's timeout.
pub(crate) async fn confirm(state: &Gateway, signature: &Signature) -> Outcome {
    let deadline = Instant::now() + state.settings.confirm_timeout;
    while Instant::now() < deadline {
        if let Ok(statuses) = state.rpc.get_signature_statuses(&[*signature]).await
            && let Some(Some(status)) = statuses.value.first()
        {
            if status.err.is_some() {
                return Outcome::FailedOnChain;
            }
            if matches!(
                status.confirmation_status,
                Some(
                    TransactionConfirmationStatus::Confirmed
                        | TransactionConfirmationStatus::Finalized
                )
            ) {
                return Outcome::Landed;
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    Outcome::Unknown
}

/// How often a send is attempted while the RPC node preflighting it has not seen the blockhash yet,
/// and how long it waits between attempts. A public RPC is many nodes behind one address: the node
/// that served the blockhash can be ahead of the one that preflights the send.
const SEND_ATTEMPTS: u32 = 8;
const SEND_RETRY_WAIT: Duration = Duration::from_millis(500);

async fn send_through_lag(
    state: &Gateway,
    transaction: &VersionedTransaction,
) -> Result<Signature, solana_rpc_client_api::client_error::Error> {
    let mut attempt = 1;
    loop {
        match state.rpc.send_transaction(transaction).await {
            Err(error)
                if attempt < SEND_ATTEMPTS
                    && matches!(
                        error.get_transaction_error(),
                        Some(TransactionError::BlockhashNotFound)
                    ) =>
            {
                attempt += 1;
                tokio::time::sleep(SEND_RETRY_WAIT).await;
            }
            result => return result,
        }
    }
}

pub(crate) async fn submit(
    State(state): State<Arc<Gateway>>,
    Json(request): Json<SubmitRequest>,
) -> Result<Json<SubmitResponse>, Error> {
    let key: [u8; 33] =
        hex_array(&request.key).ok_or(Error::BadRequest("key is not 33 bytes of hex"))?;
    let wire = BASE64_STANDARD
        .decode(&request.transaction)
        .map_err(|_| Error::BadRequest("transaction is not base64"))?;
    // Exactly two signatures, the fee payer's (empty) and the wallet's, then the message.
    if wire.len() < 1 + 128 || wire[0] != 2 {
        return Err(Error::BadRequest(
            "the transaction must carry exactly two signatures",
        ));
    }
    let wallet_signature = Signature::from(<[u8; 64]>::try_from(&wire[65..129]).unwrap());
    let bytes = &wire[129..];

    let entry = {
        let mut pending = live(&state);
        let entry = pending.get(&key).ok_or(Error::Gone)?;
        if entry.bytes != bytes {
            return Err(Error::BadRequest(
                "the message differs from the prepared one",
            ));
        }
        // Checked before the entry is consumed: without the wallet's signature nobody can cancel it.
        if !wallet_signature.verify(entry.signer.as_ref(), bytes) {
            return Err(Error::BadRequest("the wallet's signature does not verify"));
        }
        pending.remove(&key).unwrap()
    };
    let transaction = VersionedTransaction {
        signatures: vec![state.fee_payer.sign_message(bytes), wallet_signature],
        message: entry.message,
    };
    // Sent after a preflight simulation at the client's commitment: a transaction that would fail
    // is refused here, costs nothing and is not counted. Any other error leaves it unknown whether
    // the transaction was sent.
    let signature = match send_through_lag(&state, &transaction).await {
        Ok(signature) => signature,
        Err(error) => {
            return Err(match error.get_transaction_error() {
                Some(TransactionError::BlockhashNotFound) => {
                    warn!("Solana did not know the blockhash of a sponsored transaction");
                    Error::Retry
                }
                Some(error) => {
                    warn!(%error, "a sponsored transaction failed its preflight");
                    Error::Rejected
                }
                None => {
                    warn!("Solana did not say whether it took a sponsored transaction");
                    if entry.op == Op::RotationRequest {
                        let rotation = state.settings.program.find_rotation_pda(&key).0;
                        state.rotation_keys.lock().unwrap().insert(rotation, key);
                    }
                    settle(entry.reservation, Outcome::Unknown, entry.fee)
                        .expect("an unknown outcome is an error")
                }
            });
        }
    };
    info!(%signature, "sponsored transaction sent");
    let outcome = confirm(&state, &signature).await;
    if entry.op == Op::RotationRequest && outcome != Outcome::FailedOnChain {
        let rotation = state.settings.program.find_rotation_pda(&key).0;
        state.rotation_keys.lock().unwrap().insert(rotation, key);
    }
    if let Some(error) = settle(entry.reservation, outcome, entry.fee) {
        return Err(error);
    }
    Ok(Json(SubmitResponse {
        signature: signature.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        limits::Prefix,
        sponsor::{Caps, Costs, Escalation, Kind, SponsorLimits},
    };

    const COSTS: Costs = Costs {
        permanent: 924_160,
        float: 3_622_040,
    };

    fn limits() -> Arc<SponsorLimits> {
        SponsorLimits::new(Caps {
            cac_budget: 500_000_000,
            open_rent_cap: 600_000_000,
            daily_onboardings: 200,
            per_prefix_per_day: 5,
            per_prefix_per_30_days: 10,
            preparing_per_prefix: 3,
            escalation: Escalation {
                steps: Vec::new(),
                fee_on_percent: 101,
                fee_off_percent: 101,
                ..Escalation::default()
            },
        })
    }

    fn reservation(limits: &Arc<SponsorLimits>) -> Option<Reservation> {
        let network = Prefix::from("203.0.113.7".parse::<std::net::IpAddr>().unwrap());
        Some(
            limits
                .reserve(network, Kind::Onboard, COSTS, 100, 2_000_000)
                .unwrap(),
        )
    }

    /// What Solana reported decides what a sent transaction counts for.
    #[test]
    fn a_landed_transaction_opens_a_lock_and_a_failed_one_costs_only_its_fee() {
        let sponsor = limits();
        assert_eq!(settle(reservation(&sponsor), Outcome::Landed, 15_000), None);
        assert_eq!((sponsor.cac_spent(), sponsor.open_locks()), (924_160, 1));

        let sponsor = limits();
        assert_eq!(
            settle(reservation(&sponsor), Outcome::FailedOnChain, 15_000),
            Some(Error::Failed)
        );
        assert_eq!(
            (
                sponsor.cac_spent(),
                sponsor.open_locks(),
                sponsor.unknown_sends()
            ),
            (15_000, 0, 0)
        );
        let network = Prefix::from("203.0.113.7".parse::<std::net::IpAddr>().unwrap());
        assert_eq!(
            sponsor.sponsored_by(network, 100),
            1,
            "the network spent a slot"
        );

        let sponsor = limits();
        assert_eq!(
            settle(reservation(&sponsor), Outcome::Unknown, 15_000),
            Some(Error::Upstream)
        );
        assert_eq!(
            (
                sponsor.cac_spent(),
                sponsor.open_locks(),
                sponsor.unknown_sends()
            ),
            (924_160, 1, 1)
        );
    }

    #[test]
    fn an_operation_without_a_reservation_settles_without_one() {
        assert_eq!(settle(None, Outcome::Landed, 0), None);
        assert_eq!(settle(None, Outcome::FailedOnChain, 0), Some(Error::Failed));
        assert_eq!(settle(None, Outcome::Unknown, 0), Some(Error::Upstream));
    }
}
