//! The janitor against the test validator that runs the short-windows build: it returns the rents
//! the gateway lent, once the windows of the lock have passed on the chain's own clock.
mod support;

use axum::http::StatusCode;
use buckspay_gateway::{
    janitor::{self, Report},
    server::ClientAddress,
    sponsor::{Caps, SponsorLimits},
    transactions::{self, DeviceSignature, NewLock},
};
use buckspay_protocol::lock::Windows;
use serde_json::json;
use solana_keypair::Keypair;
use solana_signer::Signer;
use std::time::Duration;
use support::*;

const BOND: u64 = 2_000_000;
const BACKING: u64 = 3_000_000;
const SIGNATURE: u64 = 5_000;
const W: Windows = Windows::SHORT;

/// Onboards `wallet` through `sponsor` with a lock that the windows make due in minutes; returns
/// the device and when the release opens.
async fn onboard(sponsor: &Sponsor, wallet: &Wallet) -> (Device, u32) {
    let device = Device::random();
    let until = chain_now().await + W.min_lock() + 60;
    let prepared = sponsor
        .prepare(
            "/v1/onboard",
            &device.onboard_request(wallet, BOND, BACKING, until),
        )
        .await;
    let (status, body) = sponsor
        .submit(
            "/v1/onboard/submit",
            &device.key(),
            &prepared.signed_by(&wallet.keypair),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    (device, until + W.claim_window + W.release_delay)
}

async fn run(sponsor: &Sponsor) -> Report {
    janitor::run_once(&sponsor.gateway, janitor::ROTATION_GRACE)
        .await
        .unwrap()
}

#[tokio::test]
async fn janitor_returns_every_rent_of_a_sponsored_lock() {
    let sponsor = Sponsor::new(caps()).await;
    let wallet = associated_wallet(BOND + BACKING).await;
    let before = balance(&sponsor.fee_payer).await;
    let (device, due) = onboard(&sponsor, &wallet).await;
    assert_eq!(sponsor.gateway.sponsor.open_locks(), 1);

    // Nothing is due while the windows run.
    assert_eq!(run(&sponsor).await, Report::default());
    wait_for_chain(due).await;
    let before_release = transactions_of(&sponsor.fee_payer).await;
    let report = run(&sponsor).await;
    let escrow = lock_bumps(&device.key(), 0)[2];
    within_searching(
        "release_lock + close_lock, janitor",
        units_of_next(&sponsor.fee_payer, before_release).await,
        28_900,
        &[escrow, escrow],
        0,
        700,
    );
    assert_eq!(
        report,
        Report {
            released: 1,
            closed: 1,
            applied: 0,
            stuck: 0
        }
    );

    let lock = program().find_lock_pda(&device.key(), 0).0;
    for address in [
        lock,
        program().find_ledger_pda(&lock).0,
        program().find_escrow_pda(&lock).0,
    ] {
        assert!(account(&address).await.is_none(), "{address} is closed");
    }
    assert_eq!(token_balance(&wallet.token).await, BOND + BACKING);
    // What stays spent is the device account's rent and the signatures: three for the onboarding
    // and one for the janitor's transaction.
    let rents = rents().await;
    assert_eq!(
        before - balance(&sponsor.fee_payer).await,
        rents.device + 4 * SIGNATURE
    );
    assert_eq!(sponsor.gateway.sponsor.open_locks(), 0);
    // A second pass finds nothing.
    assert_eq!(run(&sponsor).await, Report::default());
}

#[tokio::test]
async fn janitor_ignores_ledgers_it_did_not_pay() {
    let sponsor = Sponsor::new(caps()).await;
    // A lock the wallet created and paid for itself.
    let owner = funded(1_000_000_000).await;
    let own = associated_wallet_of(&owner, BOND + BACKING).await;
    let device = Device::random();
    let until = chain_now().await + W.min_lock() + 60;
    let envelope = device.binding_envelope(&owner.pubkey());
    let signature = device.sign_binding(&owner.pubkey());
    let lock = NewLock {
        wallet: owner.pubkey(),
        key: device.key(),
        lock_seq: 0,
        funder: own.token,
        mint: cluster().mint,
        token_program: buckspay_gateway::chain::TOKEN_PROGRAM,
        bond: BOND,
        backing: BACKING,
        lock_until: until,
        sponsor_fee: 0,
        sponsor_token: None,
    };
    let instructions = transactions::onboarding(
        &program(),
        &owner.pubkey(),
        DeviceSignature {
            key: &device.key(),
            envelope: &envelope,
            signature: &signature,
        },
        &lock,
    );
    send_as(&owner, &instructions).await;
    wait_for_chain(until + W.claim_window + W.release_delay).await;
    assert_eq!(run(&sponsor).await, Report::default());
    let lock = program().find_lock_pda(&device.key(), 0).0;
    assert!(
        account(&lock).await.is_some(),
        "a self-paid lock is left alone"
    );
}

#[tokio::test]
async fn janitor_skips_a_wallet_without_a_token_account_and_reports_it() {
    let sponsor = Sponsor::new(caps()).await;
    // The funds come from an account that is not the wallet's associated token account.
    let wallet = wallet(BOND + BACKING).await;
    let (device, due) = onboard(&sponsor, &wallet).await;
    wait_for_chain(due).await;
    let before = balance(&sponsor.fee_payer).await;
    assert_eq!(
        run(&sponsor).await,
        Report {
            released: 0,
            closed: 0,
            applied: 0,
            stuck: 1
        }
    );
    let ata = buckspay_gateway::chain::associated_token_address(
        &wallet.keypair.pubkey(),
        &cluster().mint,
        &buckspay_gateway::chain::TOKEN_PROGRAM,
    );
    assert!(
        account(&ata).await.is_none(),
        "the janitor never creates the account"
    );
    assert_eq!(
        balance(&sponsor.fee_payer).await,
        before,
        "nothing was spent"
    );
    let lock = program().find_lock_pda(&device.key(), 0).0;
    assert!(account(&lock).await.is_some());
    assert_eq!(sponsor.gateway.sponsor.open_locks(), 1);
    let (_, health) = sponsor.get("203.0.113.7:1", "/health").await;
    assert_eq!(health["stuck"], 1);
}

#[tokio::test]
async fn janitor_survives_a_failed_scan() {
    let limits = SponsorLimits::new(caps());
    limits.reconcile_open_locks(3).unwrap();
    let sponsor = Sponsor::with(
        NOWHERE,
        Keypair::new(),
        limits.clone(),
        settings(),
        ClientAddress::Peer,
        rents().await,
    );
    assert!(
        janitor::run_once(&sponsor.gateway, janitor::ROTATION_GRACE)
            .await
            .is_err()
    );
    assert_eq!(
        limits.open_locks(),
        3,
        "a failed scan leaves the counter as it is"
    );
}

#[tokio::test]
async fn janitor_applies_a_rotation_only_after_the_grace() {
    let sponsor = Sponsor::new(caps()).await;
    let wallet = associated_wallet(BOND + BACKING).await;
    let (device, _) = onboard(&sponsor, &wallet).await;
    let new_wallet = Keypair::new();
    let key = device.key();
    let signature = device.sign_rotation(&wallet.keypair.pubkey(), &new_wallet.pubkey(), 0);
    let request = json!({
        "newWallet": new_wallet.pubkey().to_string(),
        "key": hex::encode(key),
        "signature": hex::encode(signature),
    });
    let prepared = sponsor.prepare("/v1/rotations/request", &request).await;
    let (status, body) = sponsor
        .submit(
            "/v1/rotations/submit",
            &key,
            &prepared.signed_by(&new_wallet),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rotation = program().find_rotation_pda(&key).0;
    let effective_at = {
        let data = account(&rotation).await.unwrap().data;
        u32::from_le_bytes(data[72..76].try_into().unwrap())
    };
    assert!(
        sponsor.gateway.sponsor.rotation_float() > 0,
        "the rent is lent"
    );

    // Until the rotation can be applied and its wallet has had the grace to cancel it, nothing.
    let grace = Duration::from_secs(20);
    let before = balance(&sponsor.fee_payer).await;
    wait_for_chain(effective_at + 1).await;
    let early = janitor::run_once(&sponsor.gateway, grace).await.unwrap();
    assert_eq!(early.applied, 0);
    assert!(account(&rotation).await.is_some());

    wait_for_chain(effective_at + 20).await;
    let before_apply = transactions_of(&sponsor.fee_payer).await;
    let report = janitor::run_once(&sponsor.gateway, grace).await.unwrap();
    assert_eq!(report.applied, 1);
    within(
        "apply_wallet_rotation, janitor",
        units_of_next(&sponsor.fee_payer, before_apply).await,
        7_500,
        0,
        500,
    );
    assert!(account(&rotation).await.is_none());
    let device_data = account(&program().find_device_pda(&key).0)
        .await
        .unwrap()
        .data;
    assert_eq!(
        device_data[8..40],
        new_wallet.pubkey().to_bytes(),
        "the wallet changed"
    );
    // The rotation's rent came back; the apply cost one signature.
    assert_eq!(
        balance(&sponsor.fee_payer).await,
        before + rents().await.rotation - SIGNATURE
    );
    assert_eq!(sponsor.gateway.sponsor.rotation_float(), 0);
}

#[tokio::test]
async fn the_open_rent_cap_stops_sponsoring_and_the_janitor_restores_it() {
    let float = rents().await.float();
    let sponsor = Sponsor::new(Caps {
        open_rent_cap: 2 * float,
        ..caps()
    })
    .await;
    let first = associated_wallet(BOND + BACKING).await;
    let second = associated_wallet(BOND + BACKING).await;
    let (_, due_first) = onboard(&sponsor, &first).await;
    let (_, due_second) = onboard(&sponsor, &second).await;

    // The float is all lent: the next onboarding is refused.
    let third = associated_wallet(BOND + BACKING).await;
    let until = chain_now().await + W.min_lock() + 60;
    let (status, _) = sponsor
        .post(
            "/v1/onboard",
            &Device::random().onboard_request(&third, BOND, BACKING, until),
        )
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

    wait_for_chain(due_first.max(due_second)).await;
    assert_eq!(run(&sponsor).await.closed, 2);
    assert_eq!(sponsor.gateway.sponsor.open_locks(), 0);
    let until = chain_now().await + W.min_lock() + 60;
    let (status, body) = sponsor
        .post(
            "/v1/onboard",
            &Device::random().onboard_request(&third, BOND, BACKING, until),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}
