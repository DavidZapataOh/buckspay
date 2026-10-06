//! Private settlements through the gateway, on the test validator: a note settles once, a chain
//! too long for one transaction settles through the proof buffer under one job, and what is
//! refused sends nothing.
mod support;

use axum::http::StatusCode;
use buckspay_gateway::{
    jobs::JobState,
    zk::{ZkRequest, job_key},
};
use buckspay_protocol::lock::Windows;
use serde_json::{Value, json};
use solana_pubkey::Pubkey;
use std::time::Duration;
use support::{zk::*, *};
use tokio::sync::Mutex;

const BOND: u64 = 20_000_000;
const BACKING: u64 = 20_000_000;

/// The tests share one validator and one pause switch.
static SERIAL: Mutex<()> = Mutex::const_new(());

fn key_of(request: &Value) -> String {
    let request: ZkRequest = serde_json::from_value(request.clone()).unwrap();
    job_key(&request.parse().unwrap())
}

async fn issuer(sponsor: &Sponsor, note: &ZkNote, seed: u8) -> Issuer {
    let issuer = Issuer::with_device(
        sponsor,
        Device::new(seed),
        BOND,
        BACKING,
        Windows::SHORT.min_lock() + 3_600,
    )
    .await;
    assert_eq!(issuer.lock(), note.lock());
    issuer
}

/// The transactions the fee payer sent after slot `since`: the validator lists them a moment
/// after they land, so this waits for `expected` and a moment more for any other.
async fn sent_since(sponsor: &Sponsor, since: u64, expected: usize) -> usize {
    let listed = || async {
        rpc(&cluster().url)
            .get_signatures_for_address(&sponsor.fee_payer)
            .await
            .unwrap()
            .iter()
            .filter(|listed| listed.slot > since)
            .count()
    };
    for _ in 0..60 {
        if listed().await >= expected {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
    listed().await
}

async fn slot() -> u64 {
    rpc(&cluster().url).get_slot().await.unwrap()
}

async fn finished(sponsor: &Sponsor, key: &str) -> JobState {
    for _ in 0..240 {
        if let Some(job) = sponsor.gateway.jobs.get(key)
            && job.state != JobState::Pending
        {
            return job.state;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("the job {key} did not finish");
}

#[tokio::test]
async fn a_three_spend_note_settles_once_and_pays_the_fee() {
    let _serial = SERIAL.lock().await;
    configure().await;
    let sponsor = Sponsor::new(caps()).await;
    let note = zk_note("n3", 21, 3);
    issuer(&sponsor, &note, 21).await;
    let payee = associated_wallet_of(&payee(), 0).await;
    let fees = fee_account().await;
    let request = note.request();
    let (paid, fee_before) = (
        token_balance(&payee.token).await,
        token_balance(&fees).await,
    );
    let sent = slot().await;

    let (status, body) = sponsor.post("/v1/settlements", &request).await;
    assert_eq!(
        (status, body["status"].as_str()),
        (StatusCode::OK, Some("submitted")),
        "{body}"
    );
    assert_eq!(finished(&sponsor, &key_of(&request)).await, JobState::Done);

    assert_eq!(
        token_balance(&payee.token).await - paid,
        PAID - 3 * RECORD_FEE
    );
    assert_eq!(token_balance(&fees).await - fee_before, 3 * RECORD_FEE);
    assert_eq!(sent_since(&sponsor, sent, 1).await, 1);
    let (status, again) = sponsor.post("/v1/settlements", &request).await;
    assert_eq!(
        (status, again["status"].as_str()),
        (StatusCode::OK, Some("duplicate")),
        "{again}"
    );
    assert_eq!(sent_since(&sponsor, sent, 1).await, 1);
}

#[tokio::test]
async fn sixteen_spends_settle_through_the_buffer_in_three_transactions_under_one_job() {
    let _serial = SERIAL.lock().await;
    configure().await;
    let sponsor = Sponsor::new(caps()).await;
    let note = zk_note("n16", 22, 16);
    issuer(&sponsor, &note, 22).await;
    let payee = associated_wallet_of(&payee(), 0).await;
    let request = note.request();
    let (paid, sent) = (token_balance(&payee.token).await, slot().await);

    let (_, body) = sponsor.post("/v1/settlements", &request).await;
    assert_eq!(body["status"], "submitted", "{body}");
    let key = key_of(&request);
    assert_eq!(finished(&sponsor, &key).await, JobState::Done);

    assert_eq!(sent_since(&sponsor, sent, 3).await, 3);
    assert_eq!(
        token_balance(&payee.token).await - paid,
        PAID - 16 * RECORD_FEE
    );
    assert!(
        account(&buffer_of(&sponsor, &key)).await.is_none(),
        "the settlement closes the buffer"
    );
}

#[tokio::test]
async fn what_is_refused_sends_nothing() {
    let _serial = SERIAL.lock().await;
    configure().await;
    let sponsor = Sponsor::new(caps()).await;
    let note = zk_note("n2", 23, 2);
    issuer(&sponsor, &note, 23).await;
    associated_wallet_of(&payee(), 0).await;
    let request = note.request();
    let sent = slot().await;
    let answer = |body: &Value| (body["status"].clone(), body["reason"].clone());

    let mut altered = request.clone();
    let proof = altered["messages"][1]["proof"].as_str().unwrap().to_owned();
    altered["messages"][1]["proof"] = json!(flip(&proof));
    let (status, body) = sponsor.post("/v1/settlements", &altered).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(answer(&body), (json!("refused"), json!("invalid")));

    let mut stale = request.clone();
    stale["vkSha256"] = json!(flip(request["vkSha256"].as_str().unwrap()));
    let (_, body) = sponsor.post("/v1/settlements", &stale).await;
    assert_eq!(answer(&body), (json!("refused"), json!("stale_key")));

    set_paused(true).await;
    let (_, body) = sponsor.post("/v1/settlements", &request).await;
    set_paused(false).await;
    assert_eq!(body["status"], "retry", "{body}");
    assert!(sponsor.gateway.jobs.get(&key_of(&request)).is_none());

    set_caps(PAID, PAID / 10).await;
    let (_, body) = sponsor.post("/v1/settlements", &request).await;
    set_caps(GLOBAL_CAP, LOCK_CAP).await;
    assert_eq!(body["status"], "retry", "{body}");
    assert!(
        body["retryAfter"].as_u64().is_some_and(|secs| secs > 0),
        "{body}"
    );

    let mut thin = request.clone();
    thin["payAmount"] = json!((2 * RECORD_FEE).to_string());
    let (_, body) = sponsor.post("/v1/settlements", &thin).await;
    assert_eq!(answer(&body), (json!("refused"), json!("below_fee")));

    assert_eq!(sent_since(&sponsor, sent, 0).await, 0);
}

fn buffer_of(sponsor: &Sponsor, key: &str) -> Pubkey {
    let nonce = u64::from_le_bytes(hex::decode(key).unwrap()[..8].try_into().unwrap());
    Pubkey::find_program_address(
        &[
            b"proof-buffer",
            sponsor.fee_payer.as_ref(),
            &nonce.to_le_bytes(),
        ],
        &program().id(),
    )
    .0
}

/// The base64 of `text` with its first byte changed.
fn flip(text: &str) -> String {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let mut bytes = STANDARD.decode(text).unwrap();
    bytes[0] ^= 1;
    STANDARD.encode(bytes)
}
