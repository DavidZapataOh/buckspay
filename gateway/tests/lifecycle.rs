//! Locks, withdrawals and wallet rotations sponsored end to end on the validator with the
//! short-windows program and the cluster's token programs, and what they cost in compute units and
//! bytes. Each test prints `name: measured / ceiling`.
mod support;

use axum::http::StatusCode;
use buckspay_gateway::{chain, server::Settings, sponsor::FeeMode};
use buckspay_protocol::lock::Windows;
use serde_json::json;
use solana_keypair::Keypair;
use solana_signer::Signer;
use support::*;

const BOND: u64 = 2_000_000;
const BACKING: u64 = 3_000_000;
const W: Windows = Windows::SHORT;

/// Submits a prepared transaction signed by `signer`; returns the signature and the wire size.
async fn land(
    sponsor: &Sponsor,
    path: &str,
    key: &[u8; 33],
    prepared: &Prepared,
    signer: &Keypair,
) -> (String, usize) {
    let (status, body) = sponsor.submit(path, key, &prepared.signed_by(signer)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    (
        body["signature"].as_str().unwrap().to_owned(),
        prepared.wire.len(),
    )
}

#[tokio::test]
async fn locks_withdrawals_and_rotations_are_sponsored_and_stay_within_their_ceilings() {
    let sponsor = Sponsor::new(caps()).await;
    let wallet = wallet(2 * (BOND + BACKING)).await;
    let device = Device::random();
    let key = device.key();
    let until = chain_now().await + W.min_lock() + 120;
    let rents = rents().await;
    let w = wallet.keypair.pubkey();

    let prepared = sponsor
        .prepare(
            "/v1/onboard",
            &device.onboard_request(&wallet, BOND, BACKING, until),
        )
        .await;
    let (signature, size) = land(
        &sponsor,
        "/v1/onboard/submit",
        &key,
        &prepared,
        &wallet.keypair,
    )
    .await;
    within_searching(
        "onboarding (Token)",
        units_of(&signature).await,
        40_000,
        &onboarding_bumps(&key),
        size,
        1_100,
    );

    // A later lock of the same key: the sponsor lends the rents again.
    let later = chain_now().await + W.min_lock() + 120;
    let prepared = sponsor
        .prepare(
            "/v1/locks",
            &device.lock_request(&wallet, BOND, BACKING, later),
        )
        .await;
    let (signature, size) = land(
        &sponsor,
        "/v1/locks/submit",
        &key,
        &prepared,
        &wallet.keypair,
    )
    .await;
    within_searching(
        "later lock",
        units_of(&signature).await,
        30_400,
        &lock_bumps(&key, 1),
        size,
        750,
    );
    assert_eq!(token_balance(&wallet.token).await, 0);
    assert_eq!(sponsor.gateway.sponsor.open_locks(), 2);

    // A rotation request to a new wallet that holds no SOL, and the wallet's cancel of it.
    let new_wallet = Keypair::new();
    let request = |counter: u32| {
        json!({
            "newWallet": new_wallet.pubkey().to_string(),
            "key": hex::encode(key),
            "signature": hex::encode(device.sign_rotation(&w, &new_wallet.pubkey(), counter)),
        })
    };
    let rotation = program().find_rotation_pda(&key).0;
    let before = balance(&sponsor.fee_payer).await;
    let prepared = sponsor.prepare("/v1/rotations/request", &request(0)).await;
    let (signature, size) = land(
        &sponsor,
        "/v1/rotations/submit",
        &key,
        &prepared,
        &new_wallet,
    )
    .await;
    within_searching(
        "request_wallet_rotation, sponsored",
        units_of(&signature).await,
        13_500,
        &[program().find_rotation_pda(&key).1],
        size,
        850,
    );
    let (_, pending) = sponsor
        .get(
            "203.0.113.7:1",
            &format!("/v1/rotations/pending?key={}", hex::encode(key)),
        )
        .await;
    assert_eq!(pending["pending"], true);
    assert_eq!(pending["wallet"], new_wallet.pubkey().to_string());
    assert_eq!(
        balance(&new_wallet.pubkey()).await,
        0,
        "the new wallet pays nothing"
    );

    // Two sponsored operations for one key at a time: a second request waits for the first.
    let (status, _) = sponsor.post("/v1/rotations/request", &request(1)).await;
    assert_eq!(status, StatusCode::CONFLICT, "a rotation is pending");

    let cancel = json!({ "wallet": w.to_string(), "key": hex::encode(key) });
    let prepared = sponsor.prepare("/v1/rotations/cancel", &cancel).await;
    let (signature, size) = land(
        &sponsor,
        "/v1/rotations/submit",
        &key,
        &prepared,
        &wallet.keypair,
    )
    .await;
    within(
        "cancel_wallet_rotation",
        units_of(&signature).await,
        7_600,
        size,
        600,
    );
    assert!(account(&rotation).await.is_none());
    // The rotation's rent came back; the sponsor paid the fees: 3 signatures, then 2.
    assert_eq!(before - balance(&sponsor.fee_payer).await, 5 * 5_000);
    let (_, pending) = sponsor
        .get(
            "203.0.113.7:1",
            &format!("/v1/rotations/pending?key={}", hex::encode(key)),
        )
        .await;
    assert_eq!(pending["pending"], false);

    // The first lock withdraws once its claim window has passed, to any account of the mint.
    wait_for_chain(until + W.claim_window).await;
    let destination = token_account(&Keypair::new().pubkey(), 0).await;
    let before = balance(&sponsor.fee_payer).await;
    let body = json!({ "wallet": w.to_string(), "key": hex::encode(key), "lockSeq": 0, "destination": destination.to_string() });
    let prepared = sponsor.prepare("/v1/withdrawals", &body).await;
    let (signature, size) = land(
        &sponsor,
        "/v1/withdrawals/submit",
        &key,
        &prepared,
        &wallet.keypair,
    )
    .await;
    within_searching(
        "withdraw_lock, sponsored",
        units_of(&signature).await,
        19_800,
        &lock_bumps(&key, 0)[2..],
        size,
        700,
    );
    assert_eq!(token_balance(&destination).await, BOND + BACKING);
    // The escrow's rent returned to the sponsor who paid it; the sponsor paid two signatures.
    assert_eq!(
        balance(&sponsor.fee_payer).await + 2 * 5_000 - before,
        rents.escrow
    );

    // Withdrawing it again is refused, and so is withdrawing the second lock, whose window is later.
    let (status, _) = sponsor.post("/v1/withdrawals", &body).await;
    assert_eq!(status, StatusCode::CONFLICT, "the lock was withdrawn");
    let second = json!({ "wallet": w.to_string(), "key": hex::encode(key), "lockSeq": 1, "destination": destination.to_string() });
    assert!(chain_now().await < later + W.claim_window);
    let (status, _) = sponsor.post("/v1/withdrawals", &second).await;
    assert_eq!(status, StatusCode::CONFLICT, "its window has not opened");

    // The janitor closes the withdrawn lock's records alone once the record may close; the other lock
    // is due too, but its wallet has no associated token account to release to.
    wait_for_chain(until + W.record_ttl()).await;
    let before_close = transactions_of(&sponsor.fee_payer).await;
    let report = buckspay_gateway::janitor::run_once(
        &sponsor.gateway,
        buckspay_gateway::janitor::ROTATION_GRACE,
    )
    .await
    .unwrap();
    assert_eq!(
        (report.closed, report.stuck),
        (1, 0),
        "the second lock is not due yet"
    );
    let closing = units_of_next(&sponsor.fee_payer, before_close).await;
    within_searching(
        "close_lock, janitor",
        closing,
        9_900,
        &lock_bumps(&key, 0)[2..],
        0,
        500,
    );
}

#[tokio::test]
async fn onboarding_on_token_2022_stays_within_its_ceiling() {
    let mint = mint_in(&chain::TOKEN_2022_PROGRAM).await;
    let sponsor = Sponsor::with_limits(
        buckspay_gateway::sponsor::SponsorLimits::new(caps()),
        Settings { mint, ..settings() },
    )
    .await;
    let wallet = wallet_in(&chain::TOKEN_2022_PROGRAM, &mint, BOND + BACKING).await;
    let device = Device::random();
    let until = chain_now().await + W.min_lock() + 120;
    let prepared = sponsor
        .prepare(
            "/v1/onboard",
            &device.onboard_request(&wallet, BOND, BACKING, until),
        )
        .await;
    let (signature, size) = land(
        &sponsor,
        "/v1/onboard/submit",
        &device.key(),
        &prepared,
        &wallet.keypair,
    )
    .await;
    within_searching(
        "onboarding (Token-2022)",
        units_of(&signature).await,
        43_700,
        &onboarding_bumps(&device.key()),
        size,
        1_100,
    );
    let lock = program().find_lock_pda(&device.key(), 0).0;
    assert_eq!(
        token_balance_in(&program().find_escrow_pda(&lock).0).await,
        BOND + BACKING
    );
}

async fn token_balance_in(account_address: &solana_pubkey::Pubkey) -> u64 {
    chain::TokenAccount::parse(&account(account_address).await.unwrap().data)
        .unwrap()
        .amount
}

#[tokio::test]
async fn onboarding_with_the_fee_lever_stays_within_its_ceiling() {
    let fee_payer = funded(1_000_000_000).await;
    let fee_token = token_account(&fee_payer.pubkey(), 0).await;
    let sponsor = Sponsor::with(
        &cluster().url,
        fee_payer,
        buckspay_gateway::sponsor::SponsorLimits::new(caps()),
        Settings {
            fee_mode: FeeMode::CostPlus,
            fee_token: Some(fee_token),
            sol_price_micro_usdc: Some(120_490_000),
            ..settings()
        },
        buckspay_gateway::server::ClientAddress::Peer,
        rents().await,
    );
    let quoted: u64 = sponsor.quote("203.0.113.7:1").await["fee"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let wallet = wallet(BOND + BACKING + quoted).await;
    let device = Device::random();
    let until = chain_now().await + W.min_lock() + 120;
    let prepared = sponsor
        .prepare(
            "/v1/onboard",
            &device.onboard_request(&wallet, BOND, BACKING, until),
        )
        .await;
    let (signature, size) = land(
        &sponsor,
        "/v1/onboard/submit",
        &device.key(),
        &prepared,
        &wallet.keypair,
    )
    .await;
    within_searching(
        "onboarding with the fee lever",
        units_of(&signature).await,
        43_200,
        &onboarding_bumps(&device.key()),
        size,
        1_130,
    );
    assert_eq!(token_balance(&fee_token).await, quoted);
}
