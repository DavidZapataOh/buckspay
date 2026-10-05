//! The gateway's onboarding and its limits against an Agave 4.3 `solana-test-validator` that runs
//! the short-windows build of the program (`anchor/scripts/build-short.sh` first) with the token
//! programs cloned from devnet. Refusals that must happen before Solana is read run against an RPC
//! address where nothing listens: an answer other than `502` proves the gateway refused without
//! reading Solana.
mod support;

use axum::http::StatusCode;
use base64::{Engine, prelude::BASE64_STANDARD};
use buckspay_gateway::{
    chain, message,
    server::{BODY_DEADLINE, ClientAddress, IN_FLIGHT},
    sponsor::{Caps, Escalation, FeeMode, SponsorLimits},
    sponsored::PrepareResponse,
    transactions,
};
use buckspay_protocol::lock::Windows;
use serde_json::json;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::VersionedMessage;
use solana_pubkey::Pubkey;
use solana_signature::Signature;
use solana_signer::Signer;
use std::{
    fs,
    net::SocketAddr,
    path::Path,
    time::{Duration, Instant},
};
use support::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MIN_LOCK: u32 = Windows::SHORT.min_lock();
/// 5 and 20 tokens of a 6-decimal mint.
const BOND: u64 = 2_000_000;
const BACKING: u64 = 3_000_000;
const SIGNATURE: u64 = 5_000;
const ONBOARDING_SIGNATURES: u64 = 3;

async fn until() -> u32 {
    chain_now().await + MIN_LOCK + 120
}

/// Prepares and submits an onboarding of a fresh wallet and device from `peer`; returns the status
/// of the step that stopped it, or of the submission.
async fn onboard_from(sponsor: &Sponsor, peer: &str) -> StatusCode {
    onboard_across(sponsor, peer, peer).await
}

async fn onboard_across(sponsor: &Sponsor, preparer: &str, submitter: &str) -> StatusCode {
    let wallet = wallet(BOND + BACKING).await;
    let device = Device::random();
    let request = device.onboard_request(&wallet, BOND, BACKING, until().await);
    let (status, body) = sponsor
        .post_from(preparer, "/v1/onboard", request.to_string())
        .await;
    if status != StatusCode::OK {
        return status;
    }
    let prepared = Prepared::from(body);
    sponsor
        .submit_from(
            submitter,
            "/v1/onboard/submit",
            &device.key(),
            &prepared.signed_by(&wallet.keypair),
        )
        .await
        .0
}

/// Prepares an onboarding of a fresh wallet from `peer` without submitting it.
async fn prepare_from(sponsor: &Sponsor, peer: &str) -> StatusCode {
    let wallet = wallet(BOND + BACKING).await;
    let request = Device::random().onboard_request(&wallet, BOND, BACKING, until().await);
    sponsor
        .post_from(peer, "/v1/onboard", request.to_string())
        .await
        .0
}

/// The instructions of the onboarding of `wallet` and `device`, as the app builds them.
fn onboarding_instructions(
    fee_payer: &Pubkey,
    wallet: &Wallet,
    device: &Device,
    until: u32,
) -> Vec<Instruction> {
    let lock = transactions::NewLock {
        wallet: wallet.keypair.pubkey(),
        key: device.key(),
        lock_seq: 0,
        funder: wallet.token,
        mint: cluster().mint,
        token_program: chain::TOKEN_PROGRAM,
        bond: BOND,
        backing: BACKING,
        lock_until: until,
        sponsor_fee: 0,
        sponsor_token: None,
    };
    let envelope = device.binding_envelope(&wallet.keypair.pubkey());
    let signature = device.sign_binding(&wallet.keypair.pubkey());
    transactions::onboarding(
        &program(),
        fee_payer,
        transactions::DeviceSignature {
            key: &device.key(),
            envelope: &envelope,
            signature: &signature,
        },
        &lock,
    )
}

fn prepared_message(
    sponsor: &Sponsor,
    prepared: &Prepared,
    instructions: &[Instruction],
) -> VersionedMessage {
    transactions::compose(
        &sponsor.fee_payer,
        prepared.body["computeUnitLimit"].as_u64().unwrap() as u32,
        prepared.body["computeUnitPrice"].as_u64().unwrap(),
        instructions,
        prepared.body["blockhash"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap(),
    )
}

#[tokio::test]
async fn onboarding_is_atomic_end_to_end() {
    let sponsor = Sponsor::new(caps()).await;
    let wallet = wallet(BOND + BACKING).await;
    let device = Device::random();
    let rents = rents().await;
    let before = balance(&sponsor.fee_payer).await;

    let prepared = sponsor
        .prepare(
            "/v1/onboard",
            &device.onboard_request(&wallet, BOND, BACKING, until().await),
        )
        .await;
    assert_eq!(prepared.body["feePayer"], sponsor.fee_payer.to_string());
    assert_eq!(prepared.body["sponsorFee"], "0");
    // No recent fees on a fresh validator: the policy's price is 0.
    assert_eq!(prepared.body["computeUnitPrice"], 0);
    let response: PrepareResponse = serde_json::from_value(prepared.body.clone()).unwrap();
    assert!((10_000..=100_000).contains(&response.compute_unit_limit));

    let (status, body) = sponsor
        .submit(
            "/v1/onboard/submit",
            &device.key(),
            &prepared.signed_by(&wallet.keypair),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let key = device.key();
    let device_account = account(&program().find_device_pda(&key).0)
        .await
        .expect("registered");
    assert_eq!(device_account.owner, program().id());
    assert_eq!(device_account.data.len(), 49);
    assert_eq!(
        device_account.data[8..40],
        wallet.keypair.pubkey().to_bytes()
    );
    let lock = program().find_lock_pda(&key, 0).0;
    for (address, len) in [
        (lock, 61),
        (program().find_ledger_pda(&lock).0, 103),
        (program().find_escrow_pda(&lock).0, 165),
    ] {
        assert_eq!(account(&address).await.unwrap().data.len(), len);
    }
    assert_eq!(
        token_balance(&program().find_escrow_pda(&lock).0).await,
        BOND + BACKING
    );
    assert_eq!(token_balance(&wallet.token).await, 0);
    assert_eq!(
        balance(&wallet.keypair.pubkey()).await,
        0,
        "the wallet never touches SOL"
    );
    // The sponsor paid the four rents and the three signatures the fee counts.
    assert_eq!(
        before - balance(&sponsor.fee_payer).await,
        rents.device + rents.float() + ONBOARDING_SIGNATURES * SIGNATURE
    );
    assert_eq!(sponsor.gateway.sponsor.open_locks(), 1);

    // A replay finds nothing to sign.
    let (status, _) = sponsor
        .submit(
            "/v1/onboard/submit",
            &device.key(),
            &prepared.signed_by(&wallet.keypair),
        )
        .await;
    assert_eq!(status, StatusCode::GONE);
}

#[tokio::test]
async fn a_wallet_without_the_funds_is_not_sponsored() {
    let sponsor = Sponsor::new(caps()).await;
    let until = until().await;
    for tokens in [0, BOND + BACKING - 1] {
        let wallet = wallet(tokens).await;
        let (status, _) = sponsor
            .post(
                "/v1/onboard",
                &Device::random().onboard_request(&wallet, BOND, BACKING, until),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{tokens} tokens");
    }
    assert_eq!(sponsor.gateway.sponsor.preparing(), 0);
}

/// The wallet moves its tokens between prepare and submit: the preflight simulation refuses the
/// transaction, so nothing is sent and the sponsor pays nothing; a transaction that did land and
/// fail is settled in `settle`'s own tests.
#[tokio::test]
async fn a_wallet_that_moves_its_tokens_between_prepare_and_submit_costs_nothing() {
    let sponsor = Sponsor::new(caps()).await;
    let wallet = wallet(BOND + BACKING).await;
    let device = Device::random();
    let prepared = sponsor
        .prepare(
            "/v1/onboard",
            &device.onboard_request(&wallet, BOND, BACKING, until().await),
        )
        .await;
    move_tokens(&wallet.keypair, &wallet.token, 1).await;
    let before = balance(&sponsor.fee_payer).await;
    let (status, body) = sponsor
        .submit(
            "/v1/onboard/submit",
            &device.key(),
            &prepared.signed_by(&wallet.keypair),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(balance(&sponsor.fee_payer).await, before);
    assert!(
        account(&program().find_device_pda(&device.key()).0)
            .await
            .is_none()
    );
    assert_eq!(
        (
            sponsor.gateway.sponsor.cac_spent(),
            sponsor.gateway.sponsor.open_locks()
        ),
        (0, 0)
    );
}

async fn rewrite_fixture(name: &str, json: &str) {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    if std::env::var_os("WRITE_FIXTURE").is_some() {
        fs::write(&path, json).unwrap();
    }
    assert_eq!(
        fs::read_to_string(&path).unwrap_or_default(),
        json,
        "run: WRITE_FIXTURE=1 cargo test --test onboarding fixtures_are_current"
    );
}

/// The messages the app rebuilds byte for byte, for fixed keys: the app's Vitest reads these files.
#[tokio::test]
async fn fixtures_are_current() {
    use buckspay_client::{Program, programs::BUCKSPAY_ID};
    use buckspay_protocol::{
        cluster::DEVNET_GENESIS_HASH,
        device::device_binding_envelope,
        hash::{domain, purpose},
    };
    let production = Program::new(BUCKSPAY_ID);
    let wallet = Keypair::new_from_array([0x57; 32]).pubkey();
    let fee_payer = Keypair::new_from_array([0x9a; 32]).pubkey();
    let device = Device::new(9);
    let key = device.key();
    let funder = Keypair::new_from_array([0x31; 32]).pubkey();
    let mint = Keypair::new_from_array([0x32; 32]).pubkey();
    let destination = Keypair::new_from_array([0x33; 32]).pubkey();
    let new_wallet = Keypair::new_from_array([0x58; 32]).pubkey();
    let blockhash = solana_hash::Hash::new_from_array([0x42; 32]);
    let (limit, price) = (60_000, 12_345);
    let domain = domain(
        purpose::DEVICE,
        &DEVNET_GENESIS_HASH,
        &BUCKSPAY_ID.to_bytes(),
    );
    let sign = |envelope: &[u8; 96]| -> [u8; 64] {
        use p256::ecdsa::{Signature, signature::Signer as _};
        let signature: Signature = device.0.sign(envelope);
        signature.normalize_s().to_bytes().into()
    };
    let binding = device_binding_envelope(&domain, &wallet.to_bytes(), &key).unwrap();
    let binding_signature = sign(&binding);
    let lock = |seq: u32, fee: u64, token: Option<Pubkey>| transactions::NewLock {
        wallet,
        key,
        lock_seq: seq,
        funder,
        mint,
        token_program: chain::TOKEN_PROGRAM,
        bond: BOND,
        backing: BACKING,
        lock_until: 1_900_000_000,
        sponsor_fee: fee,
        sponsor_token: token,
    };
    let message = |instructions: &[Instruction]| {
        BASE64_STANDARD.encode(
            transactions::compose(&fee_payer, limit, price, instructions, blockhash).serialize(),
        )
    };
    let sponsor_token = Keypair::new_from_array([0x34; 32]).pubkey();
    let onboarding = |fee: u64, token: Option<Pubkey>| {
        message(&transactions::onboarding(
            &production,
            &fee_payer,
            transactions::DeviceSignature {
                key: &key,
                envelope: &binding,
                signature: &binding_signature,
            },
            &lock(0, fee, token),
        ))
    };
    let mut json = serde_json::to_string_pretty(&json!({
        "programId": BUCKSPAY_ID.to_string(),
        "wallet": wallet.to_string(),
        "feePayer": fee_payer.to_string(),
        "device": hex::encode(key),
        "signature": hex::encode(binding_signature),
        "envelope": hex::encode(binding),
        "funder": funder.to_string(),
        "mint": mint.to_string(),
        "feeRecipient": sponsor_token.to_string(),
        "bond": BOND.to_string(),
        "backing": BACKING.to_string(),
        "lockUntil": 1_900_000_000,
        "blockhash": blockhash.to_string(),
        "computeUnitLimit": limit,
        "computeUnitPrice": price,
        "message": onboarding(0, None),
        "messageWithFee": onboarding(150_000, Some(sponsor_token)),
    }))
    .unwrap();
    json.push('\n');
    rewrite_fixture("onboard.json", &json).await;

    let old = Keypair::new_from_array([0x57; 32]).pubkey();
    let rotation_envelope = buckspay_protocol::device::device_rotation_envelope(
        &domain,
        &old.to_bytes(),
        &new_wallet.to_bytes(),
        &key,
        2,
    )
    .unwrap();
    let rotation_signature = sign(&rotation_envelope);
    let mut json = serde_json::to_string_pretty(&json!({
        "programId": BUCKSPAY_ID.to_string(),
        "wallet": wallet.to_string(),
        "newWallet": new_wallet.to_string(),
        "feePayer": fee_payer.to_string(),
        "device": hex::encode(key),
        "funder": funder.to_string(),
        "mint": mint.to_string(),
        "destination": destination.to_string(),
        "rentReceiver": fee_payer.to_string(),
        "lockSeq": 3,
        "rotations": 2,
        "rotationSignature": hex::encode(rotation_signature),
        "rotationEnvelope": hex::encode(rotation_envelope),
        "bond": BOND.to_string(),
        "backing": BACKING.to_string(),
        "lockUntil": 1_900_000_000,
        "blockhash": blockhash.to_string(),
        "computeUnitLimit": limit,
        "computeUnitPrice": price,
        "lock": message(&[transactions::create_lock(&production, &fee_payer, &lock(3, 0, None))]),
        "withdrawal": message(&[transactions::withdrawal(
            &production,
            &transactions::Withdrawal {
                wallet,
                rent_receiver: fee_payer,
                key,
                lock_seq: 3,
                mint,
                token_program: chain::TOKEN_PROGRAM,
                destination,
            },
        )]),
        "rotationRequest": message(&transactions::rotation_request(
            &production,
            &fee_payer,
            &new_wallet,
            transactions::DeviceSignature {
                key: &key,
                envelope: &rotation_envelope,
                signature: &rotation_signature,
            },
        )),
        "rotationCancel": message(&[transactions::rotation_cancel(&production, &wallet, &fee_payer, &key)]),
    }))
    .unwrap();
    json.push('\n');
    rewrite_fixture("operations.json", &json).await;
}

#[tokio::test]
async fn the_prepared_message_is_what_the_builders_produce() {
    let sponsor = Sponsor::new(caps()).await;
    let wallet = wallet(BOND + BACKING).await;
    let device = Device::random();
    let until = until().await;
    let prepared = sponsor
        .prepare(
            "/v1/onboard",
            &device.onboard_request(&wallet, BOND, BACKING, until),
        )
        .await;
    let expected = prepared_message(
        &sponsor,
        &prepared,
        &onboarding_instructions(&sponsor.fee_payer, &wallet, &device, until),
    );
    assert_eq!(prepared.message(), expected.serialize());
    let VersionedMessage::V0(v0) = &expected else {
        panic!("not a version 0 message")
    };
    assert!(v0.address_table_lookups.is_empty());
    assert_eq!(v0.header.num_required_signatures, 2);
    // The wallet is the second signer and the one read-only signed account: it pays nothing.
    assert_eq!(v0.header.num_readonly_signed_accounts, 1);
    assert_eq!(
        v0.account_keys[..2],
        [sponsor.fee_payer, wallet.keypair.pubkey()]
    );
}

#[tokio::test]
async fn a_single_byte_change_is_refused_at_submit() {
    let sponsor = Sponsor::new(caps()).await;
    let wallet = wallet(BOND + BACKING).await;
    let device = Device::random();
    let prepared = sponsor
        .prepare(
            "/v1/onboard",
            &device.onboard_request(&wallet, BOND, BACKING, until().await),
        )
        .await;
    let bytes = prepared.message().to_vec();
    let signed = |message: &[u8]| {
        wire(
            &[Signature::default(), wallet.keypair.sign_message(message)],
            message,
        )
    };

    // Every single-byte change, signed by the wallet, is refused and leaves the entry in place.
    for at in 0..bytes.len() {
        let mut changed = bytes.clone();
        changed[at] ^= 1;
        let (status, _) = sponsor
            .submit("/v1/onboard/submit", &device.key(), &signed(&changed))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "byte {at}");
    }

    // The same blockhash and fee payer with a transfer out of the wallet, a second registration,
    // or another instruction after the lock.
    let blockhash = prepared.body["blockhash"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let transfer = Instruction {
        program_id: Pubkey::default(),
        accounts: vec![
            AccountMeta::new(wallet.keypair.pubkey(), true),
            AccountMeta::new(Pubkey::new_unique(), false),
        ],
        data: vec![2, 0, 0, 0, 0, 202, 154, 59, 0, 0, 0, 0],
    };
    let injected = message::compile(
        &sponsor.fee_payer,
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(40_000),
            transfer,
        ],
        blockhash,
    )
    .serialize();
    let (status, _) = sponsor
        .submit("/v1/onboard/submit", &device.key(), &signed(&injected))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Another key's signature, no signature, or a third signature.
    let stranger = Keypair::new();
    for (name, wire) in [
        (
            "someone else's signature",
            wire(
                &[Signature::default(), stranger.sign_message(&bytes)],
                &bytes,
            ),
        ),
        (
            "no wallet signature",
            wire(&[Signature::default(); 2], &bytes),
        ),
        (
            "three signatures",
            wire(
                &[
                    Signature::default(),
                    wallet.keypair.sign_message(&bytes),
                    Signature::default(),
                ],
                &bytes,
            ),
        ),
    ] {
        let (status, _) = sponsor
            .submit("/v1/onboard/submit", &device.key(), &wire)
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{name}");
    }
    assert!(
        account(&program().find_device_pda(&device.key()).0)
            .await
            .is_none()
    );

    // None of it cancelled the prepared transaction.
    let (status, body) = sponsor
        .submit("/v1/onboard/submit", &device.key(), &signed(&bytes))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn onboarding_for_an_existing_key_points_to_locks() {
    let sponsor = Sponsor::new(caps()).await;
    let wallet = wallet(2 * (BOND + BACKING)).await;
    let device = Device::random();
    let first = sponsor
        .prepare(
            "/v1/onboard",
            &device.onboard_request(&wallet, BOND, BACKING, until().await),
        )
        .await;
    let (status, body) = sponsor
        .submit(
            "/v1/onboard/submit",
            &device.key(),
            &first.signed_by(&wallet.keypair),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _) = sponsor
        .post(
            "/v1/onboard",
            &device.onboard_request(&wallet, BOND, BACKING, until().await),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        sponsor.gateway.sponsor.preparing(),
        0,
        "no reservation is held"
    );
    assert_eq!(sponsor.gateway.sponsor.open_locks(), 1);
}

#[tokio::test]
async fn minimum_funding_lock_duration_and_mint_are_enforced() {
    // Refused before Solana is read: against an address where nothing listens, anything but 502 proves it.
    let nowhere = Sponsor::with(
        NOWHERE,
        Keypair::new(),
        SponsorLimits::new(caps()),
        settings(),
        ClientAddress::Peer,
        rents().await,
    );
    let wallet = wallet(10 * (BOND + BACKING)).await;
    let device = Device::random();
    let now = u32::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    )
    .unwrap();
    let ok_until = now + MIN_LOCK + 60;
    let (status, body) = nowhere
        .post(
            "/v1/onboard",
            &device.onboard_request(&wallet, 1, MIN_FUNDING - 2, ok_until),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["minFunding"], MIN_FUNDING.to_string());
    for (name, until) in [
        ("too close", now + MIN_LOCK - 30),
        ("in the past", now - 10),
        ("too far for a sponsored lock", now + 46 * 86_400),
    ] {
        let (status, _) = nowhere
            .post(
                "/v1/onboard",
                &device.onboard_request(&wallet, BOND, BACKING, until),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{name}");
    }
    assert_eq!(nowhere.gateway.sponsor.preparing(), 0);

    // A funder of another mint is refused once Solana is read.
    let sponsor = Sponsor::new(caps()).await;
    let foreign = foreign_wallet(BOND + BACKING).await;
    let (status, _) = sponsor
        .post(
            "/v1/onboard",
            &device.onboard_request(&foreign, BOND, BACKING, ok_until),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(sponsor.gateway.sponsor.preparing(), 0);
}

#[tokio::test]
async fn prepares_from_one_network_submitted_from_another_charge_the_preparing_network() {
    let sponsor = Sponsor::new(Caps {
        per_prefix_per_day: 1,
        ..caps()
    })
    .await;
    assert_eq!(
        onboard_across(&sponsor, "203.0.113.7:1", "198.51.100.1:1").await,
        StatusCode::OK
    );
    // The network that prepared is used up for the day; the one that only submitted is not.
    assert_eq!(
        prepare_from(&sponsor, "203.0.113.8:1").await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        prepare_from(&sponsor, "198.51.100.1:1").await,
        StatusCode::OK
    );
}

#[tokio::test]
async fn many_prepares_before_any_submit_stay_within_the_caps() {
    let float = rents().await.float();
    let sponsor = Sponsor::new(Caps {
        preparing_per_prefix: 3,
        open_rent_cap: 5 * float,
        ..caps()
    })
    .await;
    for _ in 0..3 {
        assert_eq!(
            prepare_from(&sponsor, "203.0.113.7:1").await,
            StatusCode::OK
        );
    }
    assert_eq!(
        prepare_from(&sponsor, "203.0.113.8:1").await,
        StatusCode::TOO_MANY_REQUESTS
    );
    // Other networks still work, until the float cap is reached by reservations alone.
    for network in ["198.51.100.1:1", "192.0.2.1:1"] {
        assert_eq!(prepare_from(&sponsor, network).await, StatusCode::OK);
    }
    assert_eq!(
        prepare_from(&sponsor, "[2001:db8::1]:1").await,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        sponsor.gateway.sponsor.cac_spent(),
        0,
        "nothing was spent yet"
    );
}

#[tokio::test]
async fn expired_pending_entries_release_cac_and_float_on_status_and_quote_requests() {
    let sponsor = Sponsor::with_limits(
        SponsorLimits::new(caps()),
        buckspay_gateway::server::Settings {
            pending_ttl: Duration::from_secs(2),
            ..settings()
        },
    )
    .await;
    assert_eq!(
        prepare_from(&sponsor, "203.0.113.1:1").await,
        StatusCode::OK
    );
    assert_eq!(
        prepare_from(&sponsor, "198.51.100.1:1").await,
        StatusCode::OK
    );
    assert_eq!(sponsor.gateway.sponsor.preparing(), 2);
    tokio::time::sleep(Duration::from_millis(2_500)).await;
    // A quote request alone releases them.
    assert_eq!(sponsor.quote("192.0.2.1:1").await["available"], true);
    assert_eq!(sponsor.gateway.sponsor.preparing(), 0);
}

#[tokio::test]
async fn caps_and_open_locks_survive_a_restart() {
    let path = Path::new(env!("CARGO_TARGET_TMPDIR")).join("restart-sponsorships.json");
    let _ = fs::remove_file(&path);
    let limited = Caps {
        per_prefix_per_day: 1,
        ..caps()
    };
    let sponsor = Sponsor::with_limits(
        SponsorLimits::open(limited.clone(), &path).unwrap(),
        settings(),
    )
    .await;
    assert_eq!(
        onboard_from(&sponsor, "203.0.113.7:1").await,
        StatusCode::OK
    );
    let spent = sponsor.gateway.sponsor.cac_spent();
    assert!(spent > 0);
    drop(sponsor);

    let restarted =
        Sponsor::with_limits(SponsorLimits::open(limited, &path).unwrap(), settings()).await;
    assert_eq!(
        (
            restarted.gateway.sponsor.cac_spent(),
            restarted.gateway.sponsor.open_locks()
        ),
        (spent, 1)
    );
    assert_eq!(
        prepare_from(&restarted, "203.0.113.8:1").await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        prepare_from(&restarted, "198.51.100.1:1").await,
        StatusCode::OK
    );
}

#[tokio::test]
async fn withdrawals_cancels_and_rotation_requests_are_rate_limited_per_key_and_network() {
    let sponsor = Sponsor::with_requests(
        &cluster().url,
        funded(1_000_000_000).await,
        SponsorLimits::new(caps()),
        settings(),
        ClientAddress::Peer,
        rents().await,
        30,
    );
    for path in [
        "/v1/withdrawals",
        "/v1/rotations/cancel",
        "/v1/rotations/request",
    ] {
        // Thirty requests a minute from a network reach the handler (and are refused there as
        // malformed); the thirty-first is refused before it is read.
        let (status, _) = sponsor.post_from("198.51.100.9:1", path, "{".into()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}");
    }
    for _ in 0..27 {
        let (status, _) = sponsor
            .post_from("198.51.100.9:1", "/v1/withdrawals", "{".into())
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let (status, _) = sponsor
        .post_from("198.51.100.9:1", "/v1/withdrawals", "{".into())
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn quote_and_prepare_follow_the_escalation_ladder_over_http() {
    let rents = rents().await;
    let float = rents.float();
    let wallet_fee_token = token_account(&Pubkey::new_unique(), 0).await;
    let limits = SponsorLimits::new(Caps {
        open_rent_cap: 165 * float,
        escalation: Escalation::default(),
        ..caps()
    });
    let sponsor = Sponsor::with_limits(
        limits,
        buckspay_gateway::server::Settings {
            fee_token: Some(wallet_fee_token),
            sol_price_micro_usdc: Some(120_490_000),
            ..settings()
        },
    )
    .await;
    // Rents are read at the gateway's start: the cap above is 165 locks of this float.
    for (open, minimum, mode) in [
        (82, 2_000_000u64, "off"),
        (83, 5_000_000, "cost_plus"),
        (108, 10_000_000, "cost_plus"),
        (133, 25_000_000, "cost_plus"),
        (150, 50_000_000, "cost_plus"),
    ] {
        sponsor.gateway.sponsor.reconcile_open_locks(open).unwrap();
        let quote = sponsor.quote("203.0.113.7:1").await;
        assert_eq!(quote["minFunding"], minimum.to_string(), "{open} locks");
        assert_eq!(quote["feeMode"], mode, "{open} locks");
    }
    // A prepare below the quoted minimum answers 409 with the minimum and reserves nothing.
    let wallet = wallet(BOND + BACKING).await;
    let (status, body) = sponsor
        .post(
            "/v1/onboard",
            &Device::random().onboard_request(&wallet, BOND, BACKING, until().await),
        )
        .await;
    assert_eq!(
        (status, body["minFunding"].as_str()),
        (StatusCode::CONFLICT, Some("50000000"))
    );
    assert_eq!(sponsor.gateway.sponsor.preparing(), 0);

    sponsor.gateway.sponsor.reconcile_open_locks(62).unwrap();
    let quote = sponsor.quote("203.0.113.7:1").await;
    assert_eq!(
        (quote["minFunding"].as_str(), quote["feeMode"].as_str()),
        (Some("2000000"), Some("off"))
    );
}

#[tokio::test]
async fn fee_mode_off_quotes_zero_and_cost_plus_matches_the_formula() {
    let rents = rents().await;
    let off = Sponsor::new(caps()).await;
    let quote = off.quote("203.0.113.7:1").await;
    assert_eq!(
        (quote["fee"].as_str(), quote["feeMode"].as_str()),
        (Some("0"), Some("off"))
    );
    assert_eq!(quote["maxLockDays"], 45);

    let fee_payer = funded(1_000_000_000).await;
    let fee_token = token_account(&fee_payer.pubkey(), 0).await;
    let priced = |price| buckspay_gateway::server::Settings {
        fee_mode: FeeMode::CostPlus,
        fee_token: Some(fee_token),
        sol_price_micro_usdc: price,
        ..settings()
    };
    let sponsor = Sponsor::with(
        &cluster().url,
        fee_payer.insecure_clone(),
        SponsorLimits::new(caps()),
        priced(Some(120_490_000)),
        ClientAddress::Peer,
        rents,
    );
    let permanent = rents.device + 3 * SIGNATURE + 10_000;
    let expected =
        buckspay_gateway::sponsor::cost_plus_fee(permanent, 110, 120_490_000, 50_000).unwrap();
    let quote = sponsor.quote("203.0.113.7:1").await;
    assert_eq!(quote["fee"], expected.to_string());
    assert_eq!(quote["feeMode"], "cost_plus");

    // The prepared lock carries the fee, and the wallet needs funds for both.
    let wallet = wallet(BOND + BACKING + expected).await;
    let device = Device::random();
    let prepared = sponsor
        .prepare(
            "/v1/onboard",
            &device.onboard_request(&wallet, BOND, BACKING, until().await),
        )
        .await;
    assert_eq!(prepared.body["sponsorFee"], expected.to_string());
    let (status, body) = sponsor
        .submit(
            "/v1/onboard/submit",
            &device.key(),
            &prepared.signed_by(&wallet.keypair),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(token_balance(&fee_token).await, expected);
    assert_eq!(token_balance(&wallet.token).await, 0);

    // Without a price the gateway cannot quote a fee, and says so instead of guessing.
    let unpriced = Sponsor::with(
        &cluster().url,
        fee_payer,
        SponsorLimits::new(caps()),
        priced(None),
        ClientAddress::Peer,
        rents,
    );
    let quote = unpriced.quote("203.0.113.7:1").await;
    assert_eq!(
        (quote["available"].as_bool(), quote["reason"].as_str()),
        (Some(false), Some("fee_unavailable"))
    );
}

#[tokio::test]
async fn no_endpoint_accepts_the_gateways_own_key_as_the_wallet() {
    let attester = Keypair::new().pubkey();
    let held = Keypair::new().pubkey();
    let path = Path::new(env!("CARGO_TARGET_TMPDIR")).join("own-key-sponsorships.json");
    let _ = fs::remove_file(&path);
    let limits = SponsorLimits::open(caps(), &path).unwrap();
    let sponsor = Sponsor::with(
        NOWHERE,
        Keypair::new(),
        limits,
        buckspay_gateway::server::Settings {
            held_keys: vec![attester, held],
            ..settings()
        },
        ClientAddress::Peer,
        rents().await,
    );
    let device = Device::random();
    let key = hex::encode(device.key());
    for ours in [sponsor.fee_payer, attester, held] {
        let ours = ours.to_string();
        let bodies = [
            (
                "/v1/onboard",
                json!({ "wallet": ours, "key": key, "funder": ours, "bond": "1", "backing": "1", "lockUntil": 1, "signature": "00" }),
            ),
            (
                "/v1/locks",
                json!({ "wallet": ours, "key": key, "funder": ours, "bond": "1", "backing": "1", "lockUntil": 1 }),
            ),
            (
                "/v1/withdrawals",
                json!({ "wallet": ours, "key": key, "lockSeq": 0, "destination": ours }),
            ),
            (
                "/v1/rotations/request",
                json!({ "newWallet": ours, "key": key, "signature": "00" }),
            ),
            (
                "/v1/rotations/cancel",
                json!({ "wallet": ours, "key": key }),
            ),
        ];
        for (path, body) in bodies {
            let (status, body) = sponsor.post(path, &body).await;
            assert_eq!(
                (status, body["error"].as_str()),
                (StatusCode::BAD_REQUEST, Some("wallet is the gateway")),
                "{path} {ours}"
            );
        }
    }
    assert_eq!(sponsor.gateway.sponsor.preparing(), 0);
    assert!(!path.exists(), "the ledger file was not touched");
}

#[tokio::test]
async fn a_submission_whose_outcome_is_unknown_is_counted_and_answers_502() {
    let (url, relay) = relay(&cluster().url).await;
    let fee_payer = funded(1_000_000_000).await;
    let limits = SponsorLimits::new(Caps {
        per_prefix_per_day: 1,
        ..caps()
    });
    let sponsor = Sponsor::with(
        &url,
        fee_payer.insecure_clone(),
        limits.clone(),
        settings(),
        ClientAddress::Peer,
        rents().await,
    );
    let wallet = wallet(BOND + BACKING).await;
    let device = Device::random();
    let prepared = sponsor
        .prepare(
            "/v1/onboard",
            &device.onboard_request(&wallet, BOND, BACKING, until().await),
        )
        .await;
    relay.abort();
    let _ = relay.await;
    let (status, _) = sponsor
        .submit(
            "/v1/onboard/submit",
            &device.key(),
            &prepared.signed_by(&wallet.keypair),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    // Counted as sent: the permanent cost, an open lock, the preparing network's slot.
    assert_eq!((limits.open_locks(), limits.unknown_sends()), (1, 1));
    assert!(limits.cac_spent() > 0);
    assert_eq!(
        prepare_from(&sponsor, PEER).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    let quote = sponsor.quote(PEER).await;
    assert_eq!(quote["reason"], "network_limit");

    // The janitor's reconcile corrects the open-lock count when the chain shows no lock.
    let real = Sponsor::with(
        &cluster().url,
        fee_payer,
        limits.clone(),
        settings(),
        ClientAddress::Peer,
        rents().await,
    );
    buckspay_gateway::janitor::run_once(&real.gateway, buckspay_gateway::janitor::ROTATION_GRACE)
        .await
        .unwrap();
    assert_eq!(limits.open_locks(), 0);
}

#[tokio::test]
async fn a_submit_with_a_message_rewritten_by_the_wallet_is_refused_and_counts_nothing() {
    let sponsor = Sponsor::with_limits(
        SponsorLimits::new(caps()),
        buckspay_gateway::server::Settings {
            pending_ttl: Duration::from_secs(2),
            ..settings()
        },
    )
    .await;
    let wallet = wallet(BOND + BACKING).await;
    let device = Device::random();
    let until = until().await;
    let prepared = sponsor
        .prepare(
            "/v1/onboard",
            &device.onboard_request(&wallet, BOND, BACKING, until),
        )
        .await;
    let instructions = onboarding_instructions(&sponsor.fee_payer, &wallet, &device, until);
    let signed = |message: &VersionedMessage| {
        let bytes = message.serialize();
        wire(
            &[Signature::default(), wallet.keypair.sign_message(&bytes)],
            &bytes,
        )
    };

    // The wallet appends an instruction, changes the compute-budget pair, or reorders accounts.
    let mut appended = instructions.clone();
    appended.push(appended[0].clone());
    let mut reordered = prepared_message(&sponsor, &prepared, &instructions);
    if let VersionedMessage::V0(message) = &mut reordered {
        message.account_keys.swap(2, 3);
    }
    let other_budget = transactions::compose(
        &sponsor.fee_payer,
        prepared.body["computeUnitLimit"].as_u64().unwrap() as u32 + 1,
        prepared.body["computeUnitPrice"].as_u64().unwrap(),
        &instructions,
        prepared.body["blockhash"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap(),
    );
    for (name, message) in [
        ("appended", prepared_message(&sponsor, &prepared, &appended)),
        ("budget", other_budget),
        ("reordered", reordered),
    ] {
        let (status, _) = sponsor
            .submit("/v1/onboard/submit", &device.key(), &signed(&message))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{name}");
    }
    assert!(
        account(&program().find_device_pda(&device.key()).0)
            .await
            .is_none()
    );
    assert_eq!(
        (
            sponsor.gateway.sponsor.cac_spent(),
            sponsor.gateway.sponsor.open_locks()
        ),
        (0, 0)
    );

    // The reservation is released when the entry expires.
    tokio::time::sleep(Duration::from_millis(2_500)).await;
    sponsor.quote("192.0.2.1:1").await;
    assert_eq!(sponsor.gateway.sponsor.preparing(), 0);
}

#[tokio::test]
async fn legacy_registrations_endpoint_answers_410_after_onboarding_ships() {
    let sponsor = Sponsor::new(caps()).await;
    for path in ["/v1/registrations", "/v1/registrations/submit"] {
        let (status, body) = sponsor.post(path, &json!({})).await;
        assert_eq!(status, StatusCode::GONE, "{path}");
        assert!(body["error"].as_str().unwrap().contains("/v1/onboard"));
    }
    let (status, _) = sponsor
        .get("203.0.113.7:1", "/v1/registrations/sponsorship")
        .await;
    assert_eq!(status, StatusCode::GONE);
}

#[tokio::test]
async fn limits_requests_before_reading_them() {
    let sponsor = Sponsor::with_requests(
        NOWHERE,
        Keypair::new(),
        SponsorLimits::new(caps()),
        settings(),
        ClientAddress::Peer,
        rents().await,
        2,
    );
    for _ in 0..2 {
        let (status, _) = sponsor
            .post_from("203.0.113.7:1", "/v1/onboard", "{".into())
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    // Same /24: refused before the body is parsed.
    let (status, _) = sponsor
        .post_from("203.0.113.99:1", "/v1/onboard", "{".into())
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let (status, _) = sponsor
        .post_from("198.51.100.1:1", "/v1/onboard/submit", "x".repeat(10_000))
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}

/// A fee payer that cannot pay is refused at prepare, and the app's wallet pays instead.
#[tokio::test]
async fn refuses_to_prepare_when_the_fee_payer_cannot_pay() {
    let sponsor = Sponsor::with(
        &cluster().url,
        Keypair::new(),
        SponsorLimits::new(caps()),
        settings(),
        ClientAddress::Peer,
        rents().await,
    );
    assert_eq!(
        prepare_from(&sponsor, "203.0.113.7:1").await,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(sponsor.gateway.sponsor.preparing(), 0);
}

/// A slow client holds a request no longer than the body deadline, and the gateway serves at most
/// `IN_FLIGHT` requests at once: one more is refused at once instead of waiting.
#[tokio::test]
async fn bounds_slow_requests() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let sponsor = Sponsor::with(
        NOWHERE,
        Keypair::new(),
        SponsorLimits::new(caps()),
        settings(),
        ClientAddress::Peer,
        rents().await,
    );
    tokio::spawn(
        axum::serve(
            listener,
            sponsor
                .app
                .into_make_service_with_connect_info::<SocketAddr>(),
        )
        .into_future(),
    );
    let started = Instant::now();
    let mut slow = Vec::new();
    for _ in 0..IN_FLIGHT {
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        // A body of 100 bytes, of which only the first arrives.
        stream
            .write_all(b"POST /v1/onboard HTTP/1.1\r\nHost: gateway\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{")
            .await
            .unwrap();
        slow.push(stream);
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let mut one_more = tokio::net::TcpStream::connect(address).await.unwrap();
    one_more
        .write_all(b"POST /v1/onboard HTTP/1.1\r\nHost: gateway\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
        .await
        .unwrap();
    let mut refused = String::new();
    one_more.read_to_string(&mut refused).await.unwrap();
    assert!(refused.starts_with("HTTP/1.1 503"), "{refused}");
    assert!(
        refused.ends_with(r#"{"error":"the gateway is busy"}"#),
        "{refused}"
    );

    // One byte a second keeps a body coming, and the deadline still ends its request.
    let stream = &mut slow[0];
    let mut buffer = [0; 1024];
    let read = loop {
        tokio::select! {
            read = stream.read(&mut buffer) => break read.unwrap(),
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                stream.write_all(b" ").await.unwrap();
            }
        }
        assert!(started.elapsed() < BODY_DEADLINE + Duration::from_secs(5));
    };
    let response = String::from_utf8_lossy(&buffer[..read]);
    assert!(started.elapsed() >= BODY_DEADLINE, "{response}");
    assert!(response.starts_with("HTTP/1.1 4"), "{response}");
}

/// Behind the reverse proxy the client's address is the proxy's `X-Real-IP`, and only that:
/// whatever the client puts in `X-Forwarded-For` changes nothing.
#[tokio::test]
async fn behind_the_proxy_limits_the_address_the_proxy_saw() {
    let sponsor = Sponsor::with_requests(
        NOWHERE,
        Keypair::new(),
        SponsorLimits::new(caps()),
        settings(),
        ClientAddress::Header("x-real-ip".parse().unwrap()),
        rents().await,
        1,
    );
    let request = |real: Option<&str>, forwarded: &str| {
        let mut request =
            axum::http::Request::get("/v1/onboarding/quote").header("x-forwarded-for", forwarded);
        if let Some(real) = real {
            request = request.header("x-real-ip", real);
        }
        request.body(axum::body::Body::empty()).unwrap()
    };
    let peer = "127.0.0.1:1";
    assert_eq!(
        sponsor
            .send(peer, request(Some("203.0.113.7"), "1.1.1.1"))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        sponsor
            .send(peer, request(Some("203.0.113.8"), "2.2.2.2"))
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        sponsor
            .send(peer, request(Some("198.51.100.1"), "203.0.113.7"))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        sponsor.send(peer, request(None, "192.0.2.1")).await.0,
        StatusCode::BAD_REQUEST
    );
}

/// The gateway serves a Unix socket only its owner and group can open.
#[tokio::test]
async fn serves_a_unix_socket() {
    use std::os::unix::fs::PermissionsExt;
    let path = Path::new(env!("CARGO_TARGET_TMPDIR")).join("gateway.sock");
    let listener = buckspay_gateway::server::bind_unix(&path).unwrap();
    let sponsor = Sponsor::with(
        NOWHERE,
        Keypair::new(),
        SponsorLimits::new(caps()),
        settings(),
        ClientAddress::Header("x-real-ip".parse().unwrap()),
        rents().await,
    );
    tokio::spawn(axum::serve(listener, sponsor.app).into_future());
    let mut stream = tokio::net::UnixStream::connect(&path).await.unwrap();
    stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: gateway\r\nX-Real-IP: 203.0.113.7\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
    assert!(
        response.ends_with(r#"{"openLocks":0,"status":"ok","stuck":0,"unknownSends":0}"#),
        "{response}"
    );
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o660
    );
}

#[tokio::test]
async fn publishes_the_hpke_configuration() {
    let sponsor = Sponsor::with(
        NOWHERE,
        Keypair::new(),
        SponsorLimits::new(caps()),
        settings(),
        ClientAddress::Peer,
        rents().await,
    );
    let (status, body) = sponsor.get("203.0.113.7:1", "/v1/hpke-config").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "keys": hpke().published() }));
}

/// What the gateway logs while it sponsors an onboarding: the signature, and neither the client's
/// address, its network, the wallet, the device key nor the request. The ledger it writes holds
/// counts and network prefixes only.
#[tokio::test]
async fn logs_and_ledger_never_contain_a_wallet_a_key_or_a_network_next_to_one() {
    #[derive(Clone, Default)]
    struct Captured(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
    impl std::io::Write for Captured {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let captured = Captured::default();
    let writer = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    // The process's subscriber: a scoped one misses events whose interest another test thread
    // cached without it. It also takes the other tests' lines, which must not leak either.
    tracing::subscriber::set_global_default(subscriber).unwrap();

    let path = Path::new(env!("CARGO_TARGET_TMPDIR")).join("log-sponsorships.json");
    let _ = fs::remove_file(&path);
    let sponsor =
        Sponsor::with_limits(SponsorLimits::open(caps(), &path).unwrap(), settings()).await;
    let wallet = wallet(BOND + BACKING).await;
    let device = Device::random();
    let peer = "203.0.113.77:4242";
    let request = device.onboard_request(&wallet, BOND, BACKING, until().await);
    let (_, body) = sponsor
        .post_from(peer, "/v1/onboard", request.to_string())
        .await;
    let prepared = Prepared::from(body);
    let (status, sent) = sponsor
        .submit_from(
            peer,
            "/v1/onboard/submit",
            &device.key(),
            &prepared.signed_by(&wallet.keypair),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{sent}");

    // An RPC's errors carry its URL, and a provider's URL its API key: neither is logged or returned.
    let keyed = Sponsor::with(
        "http://127.0.0.1:9/?api-key=SECRET-RPC-KEY",
        Keypair::new(),
        SponsorLimits::new(caps()),
        settings(),
        ClientAddress::Peer,
        rents().await,
    );
    let (status, body) = keyed
        .post_from(peer, "/v1/onboard", request.to_string())
        .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body, json!({ "error": "Solana is unreachable" }));

    let logs = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    assert!(logs.contains("sponsored transaction sent"), "{logs}");
    assert!(logs.contains("Solana is unreachable"), "{logs}");
    assert!(logs.contains(sent["signature"].as_str().unwrap()));
    let ledger = fs::read_to_string(&path).unwrap();
    for secret in [
        "203.0.113.77".to_owned(),
        wallet.keypair.pubkey().to_string(),
        hex::encode(device.key()),
        prepared.body["transaction"].as_str().unwrap().to_owned(),
        "SECRET-RPC-KEY".to_owned(),
        "127.0.0.1:9".to_owned(),
    ] {
        assert!(!logs.contains(&secret), "{secret} in {logs}");
        assert!(!ledger.contains(&secret), "{secret} in {ledger}");
    }
    assert!(!logs.contains("203.0.113.0"), "the network in the logs");
}
