use crate::{
    fees::priority_fee,
    limits::{Limits, Prefix, Reservation},
    message,
    server::{Client, Error, Gateway},
};
use axum::{Extension, Json, extract::State};
use base64::{Engine, prelude::BASE64_STANDARD};
use buckspay_client::{
    find_device_pda, instructions::RegisterDeviceBuilder, programs::BUCKSPAY_ID,
    register_device_compute_unit_limit,
};
use buckspay_protocol::{
    device::device_binding_envelope,
    hash::{domain, purpose},
    verify::verify_signature,
};
use serde::{Deserialize, Serialize};
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_message::VersionedMessage;
use solana_pubkey::Pubkey;
use solana_secp256r1_program::new_secp256r1_instruction_with_signature;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use std::{
    collections::HashMap,
    sync::{Arc, MutexGuard},
    time::{Duration, Instant},
};
use tracing::{error, info, warn};

/// How long a prepared registration waits for the wallet's signature, in the binary.
pub const PENDING_TTL: Duration = Duration::from_secs(90);

pub(crate) struct Pending {
    wallet: Pubkey,
    message: VersionedMessage,
    bytes: Vec<u8>,
    expires: Instant,
    /// Holds the caps of the network that prepared it until it is sent or dropped.
    reservation: Reservation,
}

/// The prepared registrations, after dropping the expired ones and so releasing their
/// reservations.
fn live(state: &Gateway) -> MutexGuard<'_, HashMap<[u8; 33], Pending>> {
    let mut pending = state.pending.lock().unwrap();
    let now = Instant::now();
    pending.retain(|_, entry| entry.expires > now);
    pending
}

/// Whether a registration from this network would be sponsored now. The app asks before it shows
/// the register step, so it never says "Free" for a registration the gateway would refuse.
pub(crate) async fn sponsorship(
    State(state): State<Arc<Gateway>>,
    Extension(Client(ip)): Extension<Client>,
) -> Result<Json<serde_json::Value>, Error> {
    drop(live(&state));
    state
        .limits
        .may_sponsor(Prefix::from(ip))
        .map_err(Error::Refused)?;
    Ok(Json(serde_json::json!({ "available": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareRequest {
    /// The wallet's address, base58.
    pub wallet: String,
    /// The compressed P-256 device key, hex.
    pub key: String,
    /// The device key's low-S signature over its binding to `wallet`, hex.
    pub signature: String,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrepareResponse {
    /// The unsigned transaction, base64: the fee payer's and the wallet's signatures are empty.
    pub transaction: String,
    pub fee_payer: String,
    pub blockhash: String,
    pub compute_unit_price: u64,
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

fn hex_array<const N: usize>(value: &str) -> Option<[u8; N]> {
    hex::decode(value).ok()?.try_into().ok()
}

/// The `[compute unit limit, compute unit price, secp256r1 verification, register_device]`
/// transaction a wallet signs and the gateway pays for: the gateway is its fee payer and the
/// program's `payer`, and the wallet signs only as `wallet`, read-only.
pub fn registration_message(
    fee_payer: &Pubkey,
    wallet: &Pubkey,
    key: &[u8; 33],
    signature: &[u8; 64],
    envelope: &[u8; 96],
    compute_unit_price: u64,
    blockhash: solana_hash::Hash,
) -> VersionedMessage {
    let (device, bump) = find_device_pda(key);
    let instructions = [
        ComputeBudgetInstruction::set_compute_unit_limit(register_device_compute_unit_limit(bump)),
        ComputeBudgetInstruction::set_compute_unit_price(compute_unit_price),
        new_secp256r1_instruction_with_signature(envelope, signature, key),
        RegisterDeviceBuilder::new()
            .wallet(*wallet)
            .payer(*fee_payer)
            .device(device)
            .key(*key)
            .instruction(),
    ];
    message::compile(fee_payer, &instructions, blockhash)
}

pub(crate) async fn prepare(
    State(state): State<Arc<Gateway>>,
    Extension(Client(ip)): Extension<Client>,
    Json(request): Json<PrepareRequest>,
) -> Result<Json<PrepareResponse>, Error> {
    let wallet: Pubkey = request
        .wallet
        .parse()
        .map_err(|_| Error::BadRequest("wallet is not an address"))?;
    let key: [u8; 33] =
        hex_array(&request.key).ok_or(Error::BadRequest("key is not 33 bytes of hex"))?;
    let signature: [u8; 64] = hex_array(&request.signature)
        .ok_or(Error::BadRequest("signature is not 64 bytes of hex"))?;
    let domain = domain(
        purpose::DEVICE,
        &state.settings.genesis_hash,
        &BUCKSPAY_ID.to_bytes(),
    );
    let envelope = device_binding_envelope(&domain, &wallet.to_bytes(), &key)
        .map_err(|_| Error::BadRequest("key is not a device key"))?;
    verify_signature(&key, &envelope, &signature)
        .map_err(|_| Error::BadRequest("the device key did not sign this binding"))?;
    // The fee payer as `wallet` would make the gateway's signature the wallet's consent.
    if wallet == state.fee_payer.pubkey() {
        return Err(Error::BadRequest("wallet is the gateway"));
    }

    // Checked and counted in one step, before Solana is read: concurrent prepares cannot all pass.
    let reservation = {
        let mut pending = live(&state);
        if pending
            .get(&key)
            .is_some_and(|entry| entry.wallet != wallet)
        {
            return Err(Error::Conflict(
                "this key is being registered to another wallet",
            ));
        }
        let reservation =
            Limits::reserve(&state.limits, Prefix::from(ip)).map_err(Error::Refused)?;
        // The same wallet prepares again: its new message replaces the old one, which a refused
        // request leaves in place.
        pending.remove(&key);
        reservation
    };

    let (device, bump) = find_device_pda(&key);
    let fee_payer = state.fee_payer.pubkey();
    // The RPC's errors carry its URL, which may hold an API key: neither is logged or returned.
    let unreachable = |_| {
        warn!("Solana is unreachable");
        Error::Upstream
    };
    let accounts = state
        .rpc
        .get_multiple_accounts_with_commitment(&[device, fee_payer], state.rpc.commitment())
        .await
        .map_err(unreachable)?
        .value;
    if accounts[0].is_some() {
        return Err(Error::Conflict("this key is already registered"));
    }
    let balance = accounts[1].as_ref().map_or(0, |account| account.lamports);
    let (blockhash, _) = state
        .rpc
        .get_latest_blockhash_with_commitment(state.rpc.commitment())
        .await
        .map_err(unreachable)?;
    let recent = state
        .rpc
        .get_recent_prioritization_fees(&[fee_payer, device])
        .await
        .map_err(unreachable)?;
    let compute_unit_price = priority_fee(
        recent.iter().map(|fee| fee.prioritization_fee).collect(),
        state.settings.max_priority_fee,
    );
    // Enough for every registration being prepared, this one included, at this price.
    let cost = state.settings.registration_cost
        + (compute_unit_price * u64::from(register_device_compute_unit_limit(bump)))
            .div_ceil(1_000_000);
    if balance < cost * state.limits.preparing() {
        warn!("the fee payer cannot pay for the registrations being prepared");
        return Err(Error::Unfunded);
    }
    let message = registration_message(
        &fee_payer,
        &wallet,
        &key,
        &signature,
        &envelope,
        compute_unit_price,
        blockhash,
    );
    let transaction = VersionedTransaction {
        signatures: vec![Signature::default(); 2],
        message: message.clone(),
    };
    let wire = wire_transaction(&transaction);
    let mut pending = live(&state);
    if pending
        .get(&key)
        .is_some_and(|entry| entry.wallet != wallet)
    {
        return Err(Error::Conflict(
            "this key is being registered to another wallet",
        ));
    }
    pending.insert(
        key,
        Pending {
            wallet,
            bytes: message.serialize(),
            message,
            expires: Instant::now() + state.settings.pending_ttl,
            reservation,
        },
    );
    Ok(Json(PrepareResponse {
        transaction: BASE64_STANDARD.encode(wire),
        fee_payer: fee_payer.to_string(),
        blockhash: blockhash.to_string(),
        compute_unit_price,
    }))
}

/// The wire format of a transaction with fewer than 128 signatures: their count, the signatures
/// and the message.
fn wire_transaction(transaction: &VersionedTransaction) -> Vec<u8> {
    let mut wire = vec![transaction.signatures.len() as u8];
    for signature in &transaction.signatures {
        wire.extend_from_slice(signature.as_ref());
    }
    wire.extend_from_slice(&transaction.message.serialize());
    wire
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
        if !wallet_signature.verify(entry.wallet.as_ref(), bytes) {
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
    // the transaction was sent: the app then waits for it.
    let signature = match state.rpc.send_transaction(&transaction).await {
        Ok(signature) => signature,
        Err(error) => match error.get_transaction_error() {
            Some(error) => {
                warn!(%error, "a sponsored registration failed its preflight");
                return Err(Error::Rejected);
            }
            None => {
                // It may still land, so it is counted as sent.
                warn!("Solana did not say whether it took a sponsored registration");
                charge(entry.reservation);
                return Err(Error::Upstream);
            }
        },
    };
    info!(%signature, "sponsored registration sent");
    charge(entry.reservation);
    Ok(Json(SubmitResponse {
        signature: signature.to_string(),
    }))
}

/// Records a sponsored registration as sent, charged to the network that prepared it.
fn charge(reservation: Reservation) {
    if let Err(error) = reservation.sponsored() {
        error!(%error, "the sponsorship ledger could not be written; sponsoring stopped");
    }
}
