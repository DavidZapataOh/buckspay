//! The sponsored operations after onboarding: later locks, withdrawals and wallet rotations.
use crate::{
    chain::{self, SIGNATURE_FEE},
    onboard::{
        address, amount, chain_now, check_funder, check_lock_until, costs, device_key, local_now,
        read, reserve, wallet,
    },
    server::{Client, Error, Gateway},
    sponsor::Kind,
    sponsored::{Draft, Op, PrepareResponse, finalize, live},
    transactions::{self, DeviceSignature, NewLock},
};
use axum::{
    Extension, Json,
    extract::{Query, State},
};
use buckspay_client::accounts::{
    DEVICE_DISCRIMINATOR, Device, LEDGER_DISCRIMINATOR, LOCK_DISCRIMINATOR, Ledger, Lock,
    ROTATION_DISCRIMINATOR, Rotation,
};
use buckspay_protocol::{
    NO_LOCK,
    device::device_rotation_envelope,
    hash::{domain, purpose},
    verify::verify_signature,
};
use serde::Deserialize;
use serde_json::json;
use solana_account::Account;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use std::sync::Arc;

/// The most compute units a later lock, a withdrawal or a rotation instruction needs, with room.
const LOCK_COMPUTE_UNIT_CEILING: u32 = 60_000;
const WITHDRAWAL_COMPUTE_UNIT_CEILING: u32 = 40_000;
const ROTATION_COMPUTE_UNIT_CEILING: u32 = 40_000;

/// The account at `address` as `T`, if the program owns it and it carries `T`'s discriminator and size.
fn decode<T>(
    account: &Option<Account>,
    program: &Pubkey,
    discriminator: [u8; 8],
    len: usize,
    from_bytes: fn(&[u8]) -> Result<T, std::io::Error>,
) -> Option<T> {
    let account = account.as_ref()?;
    (account.owner == *program && account.data.len() == len && account.data[..8] == discriminator)
        .then(|| from_bytes(&account.data).ok())
        .flatten()
}

fn device(state: &Gateway, account: &Option<Account>) -> Option<Device> {
    decode(
        account,
        &state.settings.program.id(),
        DEVICE_DISCRIMINATOR,
        Device::LEN,
        Device::from_bytes,
    )
}

fn registered_to(
    state: &Gateway,
    account: &Option<Account>,
    wallet: &Pubkey,
) -> Result<Device, Error> {
    let device = device(state, account).ok_or(Error::Conflict(
        "this key is not registered, or its device account needs migrating",
    ))?;
    if device.wallet != *wallet {
        return Err(Error::Conflict("this key is bound to another wallet"));
    }
    Ok(device)
}

/// One transaction per key at a time: another wallet cannot take over a pending entry.
fn not_pending_for_another(state: &Gateway, key: &[u8; 33], signer: &Pubkey) -> Result<(), Error> {
    if live(state)
        .get(key)
        .is_some_and(|entry| entry.signer != *signer)
    {
        return Err(Error::Conflict(
            "this key has a transaction being prepared for another wallet",
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LockRequest {
    pub wallet: String,
    pub key: String,
    pub funder: String,
    pub bond: String,
    pub backing: String,
    pub lock_until: u32,
}

/// A later lock of a registered key: the sponsor lends the rents, the wallet funds the lock.
pub(crate) async fn lock(
    State(state): State<Arc<Gateway>>,
    Extension(Client(ip)): Extension<Client>,
    Json(request): Json<LockRequest>,
) -> Result<Json<PrepareResponse>, Error> {
    let wallet = wallet(&state, &request.wallet)?;
    let key = device_key(&request.key)?;
    let funder = address(&request.funder, "funder is not an address")?;
    let (bond, backing) = (
        amount(&request.bond, "bond is not an amount")?,
        amount(&request.backing, "backing is not an amount")?,
    );
    let funding = bond
        .checked_add(backing)
        .filter(|funding| *funding > 0)
        .ok_or(Error::BadRequest("the lock has no funds"))?;
    check_lock_until(&state, local_now(), request.lock_until)?;
    not_pending_for_another(&state, &key, &wallet)?;

    let costs = costs(&state);
    let reservation = reserve(&state, ip, Kind::Lock, costs, funding)?;
    let program = state.settings.program;
    let (device_address, _) = program.find_device_pda(&key);
    let accounts = read(
        &state,
        &[
            device_address,
            funder,
            state.settings.mint,
            chain::CLOCK_SYSVAR,
        ],
    )
    .await?;
    let device = registered_to(&state, &accounts[0], &wallet)?;
    if device.next_lock_seq == NO_LOCK {
        return Err(Error::Conflict("this key has used every lock number"));
    }
    let token_program = check_funder(
        &state,
        &wallet,
        (&accounts[1], &funder),
        &accounts[2],
        funding,
    )?;
    check_lock_until(&state, chain_now(&accounts[3])?, request.lock_until)?;

    let lock = NewLock {
        wallet,
        key,
        lock_seq: device.next_lock_seq,
        funder,
        mint: state.settings.mint,
        token_program,
        bond,
        backing,
        lock_until: request.lock_until,
        sponsor_fee: 0,
        sponsor_token: None,
    };
    finalize(
        &state,
        Draft {
            op: Op::Lock,
            key,
            signer: wallet,
            instructions: vec![transactions::create_lock(
                &program,
                &state.fee_payer.pubkey(),
                &lock,
            )],
            writable: vec![device_address],
            reservation: Some(reservation),
            sponsor_fee: 0,
            cost: costs.float + 2 * SIGNATURE_FEE,
            compute_unit_ceiling: LOCK_COMPUTE_UNIT_CEILING,
            signatures: 2,
        },
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WithdrawalRequest {
    pub wallet: String,
    pub key: String,
    pub lock_seq: u32,
    /// Any token account of the lock's mint but the escrow itself.
    pub destination: String,
}

/// A withdrawal once the lock's claim window has passed; the sponsor pays only the fees, since the
/// escrow's rent goes back to whoever paid it.
pub(crate) async fn withdrawal(
    State(state): State<Arc<Gateway>>,
    Json(request): Json<WithdrawalRequest>,
) -> Result<Json<PrepareResponse>, Error> {
    let wallet = wallet(&state, &request.wallet)?;
    let key = device_key(&request.key)?;
    let destination = address(&request.destination, "destination is not an address")?;
    not_pending_for_another(&state, &key, &wallet)?;

    let program = state.settings.program;
    let (device_address, _) = program.find_device_pda(&key);
    let (lock_address, _) = program.find_lock_pda(&key, request.lock_seq);
    let (ledger_address, _) = program.find_ledger_pda(&lock_address);
    let (escrow, _) = program.find_escrow_pda(&lock_address);
    if destination == escrow {
        return Err(Error::BadRequest("destination is the escrow"));
    }
    let accounts = read(
        &state,
        &[
            device_address,
            lock_address,
            ledger_address,
            destination,
            chain::CLOCK_SYSVAR,
            escrow,
        ],
    )
    .await?;
    registered_to(&state, &accounts[0], &wallet)?;
    let id = program.id();
    let lock = decode(
        &accounts[1],
        &id,
        LOCK_DISCRIMINATOR,
        Lock::LEN,
        Lock::from_bytes,
    )
    .ok_or(Error::Conflict("there is no such lock"))?;
    let ledger = decode(
        &accounts[2],
        &id,
        LEDGER_DISCRIMINATOR,
        Ledger::LEN,
        Ledger::from_bytes,
    )
    .ok_or(Error::Conflict("there is no such lock"))?;
    if accounts[5].is_none() {
        return Err(Error::Conflict("the lock has been withdrawn"));
    }
    let opens = u64::from(lock.lock_until) + u64::from(state.settings.windows.claim_window);
    if u64::from(chain_now(&accounts[4])?) < opens {
        return Err(Error::Conflict("the lock cannot be withdrawn yet"));
    }
    let destination_account = accounts[3]
        .as_ref()
        .and_then(|account| chain::TokenAccount::parse(&account.data).map(|t| (account.owner, t)));
    let Some((token_program, token)) = destination_account else {
        return Err(Error::BadRequest("destination is not a token account"));
    };
    if token.mint != lock.mint {
        return Err(Error::BadRequest(
            "destination is not a token account of the lock's mint",
        ));
    }

    finalize(
        &state,
        Draft {
            op: Op::Withdrawal,
            key,
            signer: wallet,
            instructions: vec![transactions::withdrawal(
                &program,
                &transactions::Withdrawal {
                    wallet,
                    rent_receiver: ledger.payer,
                    key,
                    lock_seq: request.lock_seq,
                    mint: lock.mint,
                    token_program,
                    destination,
                },
            )],
            writable: vec![device_address],
            reservation: None,
            sponsor_fee: 0,
            cost: 2 * SIGNATURE_FEE,
            compute_unit_ceiling: WITHDRAWAL_COMPUTE_UNIT_CEILING,
            signatures: 2,
        },
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RotationRequest {
    pub new_wallet: String,
    pub key: String,
    /// The device key's low-S signature over the rotation, with the device's rotation counter, hex.
    pub signature: String,
}

/// A request to move a device to a new wallet, sponsored under the same caps as a lock: its rent
/// is lent until the rotation is applied or cancelled.
pub(crate) async fn rotation_request(
    State(state): State<Arc<Gateway>>,
    Extension(Client(ip)): Extension<Client>,
    Json(request): Json<RotationRequest>,
) -> Result<Json<PrepareResponse>, Error> {
    let new_wallet = wallet(&state, &request.new_wallet)?;
    let key = device_key(&request.key)?;
    let signature: [u8; 64] = crate::sponsored::hex_array(&request.signature)
        .ok_or(Error::BadRequest("signature is not 64 bytes of hex"))?;
    not_pending_for_another(&state, &key, &new_wallet)?;

    let program = state.settings.program;
    let (device_address, _) = program.find_device_pda(&key);
    let (rotation_address, _) = program.find_rotation_pda(&key);
    let rents = state.rents();
    let costs = costs(&state);
    let reservation = reserve(&state, ip, Kind::Rotation(rents.rotation), costs, 0)?;
    let accounts = read(&state, &[device_address, rotation_address]).await?;
    let device = device(&state, &accounts[0]).ok_or(Error::Conflict(
        "this key is not registered, or its device account needs migrating",
    ))?;
    if accounts[1].is_some() {
        return Err(Error::Conflict("this key has a wallet rotation pending"));
    }
    if device.wallet == new_wallet {
        return Err(Error::BadRequest("the new wallet is the current wallet"));
    }
    let device_domain = domain(
        purpose::DEVICE,
        &state.settings.genesis_hash,
        &program.id().to_bytes(),
    );
    let envelope = device_rotation_envelope(
        &device_domain,
        &device.wallet.to_bytes(),
        &new_wallet.to_bytes(),
        &key,
        device.rotations,
    )
    .map_err(|_| Error::BadRequest("key is not a device key"))?;
    verify_signature(&key, &envelope, &signature)
        .map_err(|_| Error::BadRequest("the device key did not sign this rotation"))?;

    let rotation = DeviceSignature {
        key: &key,
        envelope: &envelope,
        signature: &signature,
    };
    finalize(
        &state,
        Draft {
            op: Op::RotationRequest,
            key,
            signer: new_wallet,
            instructions: transactions::rotation_request(
                &program,
                &state.fee_payer.pubkey(),
                &new_wallet,
                rotation,
            ),
            writable: vec![device_address],
            reservation: Some(reservation),
            sponsor_fee: 0,
            cost: rents.rotation + 3 * SIGNATURE_FEE,
            compute_unit_ceiling: ROTATION_COMPUTE_UNIT_CEILING,
            signatures: 3,
        },
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelRequest {
    pub wallet: String,
    pub key: String,
}

/// The wallet's veto of a pending rotation, sponsored: its rent goes back to whoever paid it.
pub(crate) async fn rotation_cancel(
    State(state): State<Arc<Gateway>>,
    Json(request): Json<CancelRequest>,
) -> Result<Json<PrepareResponse>, Error> {
    let wallet = wallet(&state, &request.wallet)?;
    let key = device_key(&request.key)?;
    not_pending_for_another(&state, &key, &wallet)?;

    let program = state.settings.program;
    let (device_address, _) = program.find_device_pda(&key);
    let (rotation_address, _) = program.find_rotation_pda(&key);
    let accounts = read(&state, &[device_address, rotation_address]).await?;
    registered_to(&state, &accounts[0], &wallet)?;
    let rotation = decode(
        &accounts[1],
        &program.id(),
        ROTATION_DISCRIMINATOR,
        Rotation::LEN,
        Rotation::from_bytes,
    )
    .ok_or(Error::Conflict("this key has no wallet rotation pending"))?;

    finalize(
        &state,
        Draft {
            op: Op::RotationCancel,
            key,
            signer: wallet,
            instructions: vec![transactions::rotation_cancel(
                &program,
                &wallet,
                &rotation.payer,
                &key,
            )],
            writable: vec![device_address],
            reservation: None,
            sponsor_fee: 0,
            cost: 2 * SIGNATURE_FEE,
            compute_unit_ceiling: ROTATION_COMPUTE_UNIT_CEILING,
            signatures: 2,
        },
    )
    .await
}

#[derive(Deserialize)]
pub struct PendingQuery {
    key: String,
}

/// Whether a wallet rotation is pending for a key, read from the chain: the app and the wallet's
/// other devices watch it, since a thief of the device key can request one.
pub(crate) async fn rotation_pending(
    State(state): State<Arc<Gateway>>,
    Query(query): Query<PendingQuery>,
) -> Result<Json<serde_json::Value>, Error> {
    let key = device_key(&query.key)?;
    let program = state.settings.program;
    let accounts = read(&state, &[program.find_rotation_pda(&key).0]).await?;
    let pending = decode(
        &accounts[0],
        &program.id(),
        ROTATION_DISCRIMINATOR,
        Rotation::LEN,
        Rotation::from_bytes,
    );
    Ok(Json(match pending {
        Some(rotation) => json!({
            "pending": true,
            "wallet": rotation.wallet.to_string(),
            "effectiveAt": rotation.effective_at,
        }),
        None => json!({ "pending": false }),
    }))
}
