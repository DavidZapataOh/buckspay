//! Onboarding: registering a device key and funding its first lock in one transaction, so there
//! is no state "registered but unfunded", and what the gateway quotes before it.
use crate::{
    chain::{self, Rents, SIGNATURE_FEE, TokenAccount, clock_unix},
    server::{Client, Error, Gateway},
    sponsor::{Costs, FeeMode, Kind, Reservation, cost_plus_fee},
    sponsored::{Draft, Op, PrepareResponse, finalize, hex_array, live},
    transactions::{self, DeviceSignature, NewLock},
};
use axum::{Extension, Json, extract::State};
use buckspay_protocol::{
    device::device_binding_envelope,
    hash::{domain, purpose},
    lock::MAX_LOCK,
    verify::verify_signature,
};
use serde::Deserialize;
use serde_json::json;
use solana_account::Account;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

/// The most compute units any of an onboarding's instructions needs, with room.
pub const ONBOARD_COMPUTE_UNIT_CEILING: u32 = 100_000;
/// The markup of the `cost_plus` fee over the sponsor's permanent cost, in percent.
const FEE_MARKUP_PERCENT: u64 = 110;
/// The fee is rounded up to a multiple of this, in base units of the mint: 0.05 of a 6-decimal token.
const FEE_STEP: u64 = 50_000;
/// The most the gateway asks as a fee, whatever its price says: 0.5 of a 6-decimal token.
const FEE_CAP: u64 = 500_000;
/// Signatures an onboarding's fee counts: the sponsor's, the wallet's and the device key's.
pub(crate) const ONBOARD_SIGNATURES: u64 = 3;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OnboardRequest {
    /// The wallet's address, base58.
    pub wallet: String,
    /// The compressed P-256 device key, hex.
    pub key: String,
    /// The wallet's token account of the mint that funds the lock, base58.
    pub funder: String,
    /// Base units, as a decimal string.
    pub bond: String,
    pub backing: String,
    pub lock_until: u32,
    /// The device key's low-S signature over its binding to `wallet`, hex.
    pub signature: String,
}

pub(crate) fn today() -> u64 {
    now() / 86_400
}

/// This machine's clock, which is close enough to refuse a lock that is plainly out of bounds
/// before the chain's clock is read; the chain's decides.
pub(crate) fn local_now() -> u32 {
    u32::try_from(now()).unwrap_or(u32::MAX)
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

pub(crate) fn address(value: &str, what: &'static str) -> Result<Pubkey, Error> {
    value.parse().map_err(|_| Error::BadRequest(what))
}

pub(crate) fn amount(value: &str, what: &'static str) -> Result<u64, Error> {
    value.parse().map_err(|_| Error::BadRequest(what))
}

pub(crate) fn device_key(value: &str) -> Result<[u8; 33], Error> {
    hex_array(value).ok_or(Error::BadRequest("key is not 33 bytes of hex"))
}

/// A wallet the gateway is not: otherwise a request naming the gateway as the wallet would turn the
/// gateway's own signature into the wallet's consent.
pub(crate) fn wallet(state: &Gateway, value: &str) -> Result<Pubkey, Error> {
    let wallet = address(value, "wallet is not an address")?;
    if state.is_ours(&wallet) {
        return Err(Error::BadRequest("wallet is the gateway"));
    }
    Ok(wallet)
}

/// What an onboarding costs the sponsor, from the rents last read.
pub(crate) fn costs(state: &Gateway) -> Costs {
    costs_from(state, state.rents())
}

fn costs_from(state: &Gateway, rents: Rents) -> Costs {
    let priority = (state.settings.max_priority_fee * u64::from(ONBOARD_COMPUTE_UNIT_CEILING))
        .div_ceil(1_000_000);
    Costs {
        permanent: rents.device + ONBOARD_SIGNATURES * SIGNATURE_FEE + priority,
        float: rents.float(),
    }
}

/// The fee an onboarding pays the sponsor under `mode`, in base units; `None` if the gateway
/// cannot price it (no price, no account to receive it, or a price that overflows).
fn sponsor_fee(state: &Gateway, mode: FeeMode, costs: Costs) -> Option<u64> {
    match mode {
        FeeMode::Off => Some(0),
        FeeMode::CostPlus => {
            state.settings.fee_token?;
            cost_plus_fee(
                costs.permanent,
                FEE_MARKUP_PERCENT,
                state.settings.sol_price_micro_usdc?,
                FEE_STEP,
            )
            .map(|fee| fee.min(FEE_CAP))
        }
    }
}

/// The minimum sponsored funding and fee in force, and whether this network could be sponsored now.
pub(crate) async fn quote(
    State(state): State<Arc<Gateway>>,
    Extension(Client(ip)): Extension<Client>,
) -> Json<serde_json::Value> {
    drop(live(&state));
    let costs = costs(&state);
    let day = today();
    let status = state.sponsor.status(state.settings.fee_mode, costs, day);
    let fee = sponsor_fee(&state, status.fee_mode, costs);
    let reason = match fee {
        None => Some("fee_unavailable"),
        Some(_) => state
            .sponsor
            .reserve(ip.into(), Kind::Onboard, costs, day, status.min_funding)
            .err()
            .map(|refusal| reason(&refusal)),
    };
    Json(json!({
        "available": reason.is_none(),
        "fee": fee.unwrap_or(0).to_string(),
        "feeMode": match status.fee_mode { FeeMode::Off => "off", FeeMode::CostPlus => "cost_plus" },
        "minFunding": status.min_funding.to_string(),
        "pressure": status.pressure_percent,
        "maxLockDays": state.settings.max_lock_days,
        "reason": reason,
    }))
}

pub(crate) fn reason(refusal: &crate::sponsor::Refusal) -> &'static str {
    use crate::sponsor::Refusal::*;
    match refusal {
        PrefixBusy => "network_busy",
        PrefixSpentToday | PrefixSpentThisMonth => "network_limit",
        DailyCap => "daily_cap",
        CacBudget => "budget",
        OpenRentCap => "float_cap",
        BelowMinimum(_) => "below_minimum",
        Unwritable => "unavailable",
    }
}

pub(crate) fn reserve(
    state: &Gateway,
    ip: std::net::IpAddr,
    kind: Kind,
    costs: Costs,
    funding: u64,
) -> Result<Reservation, Error> {
    state
        .sponsor
        .reserve(ip.into(), kind, costs, today(), funding)
        .map_err(Error::Refused)
}

/// Reads accounts at the gateway's commitment.
pub(crate) async fn read(
    state: &Gateway,
    addresses: &[Pubkey],
) -> Result<Vec<Option<Account>>, Error> {
    Ok(state
        .rpc
        .get_multiple_accounts_with_commitment(addresses, state.rpc.commitment())
        .await
        .map_err(crate::sponsored::unreachable)?
        .value)
}

/// The chain's own time, from its clock sysvar.
pub(crate) fn chain_now(clock: &Option<Account>) -> Result<u32, Error> {
    clock
        .as_ref()
        .and_then(|account| clock_unix(&account.data))
        .and_then(|unix| u32::try_from(unix).ok())
        .ok_or(Error::Upstream)
}

/// `lock_until` is at least the shortest lock and at most the longest the gateway sponsors.
pub(crate) fn check_lock_until(state: &Gateway, now: u32, lock_until: u32) -> Result<(), Error> {
    let remaining = lock_until
        .checked_sub(now)
        .ok_or(Error::BadRequest("lockUntil is in the past"))?;
    if remaining < state.settings.windows.min_lock() {
        return Err(Error::BadRequest("lockUntil is too close"));
    }
    let longest = state
        .settings
        .max_lock_days
        .saturating_mul(86_400)
        .min(MAX_LOCK);
    if remaining > longest {
        return Err(Error::BadRequest(
            "lockUntil is too far for a sponsored lock",
        ));
    }
    Ok(())
}

/// The funder is a token account of the mint owned by the wallet, not frozen, holding `needed`.
/// Returns the token program of the mint.
pub(crate) fn check_funder(
    state: &Gateway,
    wallet: &Pubkey,
    funder: (&Option<Account>, &Pubkey),
    mint: &Option<Account>,
    needed: u64,
) -> Result<Pubkey, Error> {
    let mint = mint.as_ref().ok_or(Error::Unfunded)?;
    if mint.owner != chain::TOKEN_PROGRAM && mint.owner != chain::TOKEN_2022_PROGRAM {
        return Err(Error::Unfunded);
    }
    let funder_account = funder
        .0
        .as_ref()
        .filter(|account| account.owner == mint.owner)
        .and_then(|account| TokenAccount::parse(&account.data))
        .ok_or(Error::BadRequest(
            "funder is not a token account of the mint",
        ))?;
    if funder_account.mint != state.settings.mint || funder_account.owner != *wallet {
        return Err(Error::BadRequest(
            "funder is not the wallet's token account of the mint",
        ));
    }
    if funder_account.frozen {
        return Err(Error::BadRequest("funder is frozen"));
    }
    if funder_account.amount < needed {
        return Err(Error::BadRequest(
            "funder holds less than the lock and its fee",
        ));
    }
    Ok(mint.owner)
}

pub(crate) async fn prepare(
    State(state): State<Arc<Gateway>>,
    Extension(Client(ip)): Extension<Client>,
    Json(request): Json<OnboardRequest>,
) -> Result<Json<PrepareResponse>, Error> {
    let wallet = wallet(&state, &request.wallet)?;
    let key = device_key(&request.key)?;
    let signature: [u8; 64] = hex_array(&request.signature)
        .ok_or(Error::BadRequest("signature is not 64 bytes of hex"))?;
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
    // The pending entries that expired are released first, so their caps are free.
    let program = state.settings.program;
    let device_domain = domain(
        purpose::DEVICE,
        &state.settings.genesis_hash,
        &program.id().to_bytes(),
    );
    let envelope = device_binding_envelope(&device_domain, &wallet.to_bytes(), &key)
        .map_err(|_| Error::BadRequest("key is not a device key"))?;
    verify_signature(&key, &envelope, &signature)
        .map_err(|_| Error::BadRequest("the device key did not sign this binding"))?;
    if live(&state)
        .get(&key)
        .is_some_and(|entry| entry.signer != wallet)
    {
        return Err(Error::Conflict(
            "this key is being registered to another wallet",
        ));
    }

    let costs = costs(&state);
    let status = state
        .sponsor
        .status(state.settings.fee_mode, costs, today());
    let fee = sponsor_fee(&state, status.fee_mode, costs).ok_or(Error::Unfunded)?;
    let reservation = reserve(&state, ip, Kind::Onboard, costs, funding)?;

    let fee_payer = state.fee_payer.pubkey();
    let (device, _) = program.find_device_pda(&key);
    let accounts = read(
        &state,
        &[device, funder, state.settings.mint, chain::CLOCK_SYSVAR],
    )
    .await?;
    if accounts[0].is_some() {
        return Err(Error::Conflict(
            "this key is already registered: use /v1/locks",
        ));
    }
    let needed = funding
        .checked_add(fee)
        .ok_or(Error::BadRequest("the lock and its fee overflow"))?;
    let token_program = check_funder(
        &state,
        &wallet,
        (&accounts[1], &funder),
        &accounts[2],
        needed,
    )?;
    check_lock_until(&state, chain_now(&accounts[3])?, request.lock_until)?;

    let lock = NewLock {
        wallet,
        key,
        lock_seq: 0,
        funder,
        mint: state.settings.mint,
        token_program,
        bond,
        backing,
        lock_until: request.lock_until,
        sponsor_fee: fee,
        sponsor_token: state.settings.fee_token.filter(|_| fee > 0),
    };
    let binding = DeviceSignature {
        key: &key,
        envelope: &envelope,
        signature: &signature,
    };
    finalize(
        &state,
        Draft {
            op: Op::Onboard,
            key,
            signer: wallet,
            instructions: transactions::onboarding(&program, &fee_payer, binding, &lock),
            writable: vec![device],
            reservation: Some(reservation),
            sponsor_fee: fee,
            cost: costs.permanent + costs.float,
            compute_unit_ceiling: ONBOARD_COMPUTE_UNIT_CEILING,
            signatures: ONBOARD_SIGNATURES,
        },
    )
    .await
}
