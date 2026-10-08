//! Settling a group's remainder notes together, against the validator: packing, refusals that do not block the
//! others, and what happens to the float when one settlement in a transaction fails.
mod support;

use axum::http::StatusCode;
use base64::{Engine, prelude::BASE64_STANDARD};
use buckspay_gateway::{
    janitor,
    settlements::{Planned, SettlementRequest, inspect_settlement},
};
use buckspay_protocol::lock::Windows;
use serde_json::{Value, json};
use solana_pubkey::Pubkey;
use solana_rpc_client_api::request::RpcRequest;
use solana_signer::Signer;
use std::sync::{
    Mutex,
    atomic::{AtomicU32, Ordering},
};
use support::{netting::*, *};

const BOND: u64 = 10_000_000;
const BACKING: u64 = 10_000_000;
const AMOUNT: u64 = 1_000_000;
const W: Windows = Windows::SHORT;

/// `k` one-hop notes, each from its own lock, each settled by its holder to its own token account.
async fn notes(sponsor: &Sponsor, k: usize) -> Vec<(Note, Pubkey)> {
    let mut out = Vec::new();
    for _ in 0..k {
        let issuer = Issuer::new(sponsor, BOND, BACKING, W.min_lock() + 300).await;
        let holder = Device::random();
        let payee = wallet(0).await;
        let expiry = chain_now().await + W.min_note_life + 200;
        out.push((
            issuer.issue_to(&holder, 0, AMOUNT, expiry).settle_to(
                &holder,
                0,
                &payee.keypair.pubkey(),
            ),
            payee.token,
        ));
    }
    out
}

async fn group(sponsor: &Sponsor, notes: &[&Note]) -> (StatusCode, Value) {
    let body =
        json!({ "settlements": notes.iter().map(|n| n.settlement_request()).collect::<Vec<_>>() });
    sponsor.post("/v1/settlements/group", &body).await
}

fn indexes(body: &Value) -> Vec<Vec<u64>> {
    body["transactions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| {
            t["indexes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|i| i.as_u64().unwrap())
                .collect()
        })
        .collect()
}

#[tokio::test]
async fn packs_k_notes_in_one_transaction() {
    let sponsor = Sponsor::new(caps()).await;
    let ns = notes(&sponsor, 3).await;
    let (status, body) = group(&sponsor, &ns.iter().map(|n| &n.0).collect::<Vec<_>>()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(indexes(&body), vec![vec![0, 1, 2]]);
    for (_, token) in &ns {
        assert_eq!(token_balance(token).await, AMOUNT);
    }
}

#[tokio::test]
async fn splits_when_over_size() {
    let sponsor = Sponsor::new(caps()).await;
    let ns = notes(&sponsor, 8).await;
    let (status, body) = group(&sponsor, &ns.iter().map(|n| &n.0).collect::<Vec<_>>()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let packed = indexes(&body);
    assert!(packed.len() >= 2, "{body}");
    assert_eq!(packed.concat(), (0..8).collect::<Vec<u64>>());
    for (_, token) in &ns {
        assert_eq!(token_balance(token).await, AMOUNT);
    }
}

#[tokio::test]
async fn refused_chain_does_not_block_others() {
    let sponsor = Sponsor::new(caps()).await;
    let ns = notes(&sponsor, 3).await;
    let mut bad = ns[1].0.settlement_request();
    let mut spend = hex::decode(bad["spends"][0].as_str().unwrap()).unwrap();
    let last = spend.len() - 1;
    spend[last] ^= 1;
    bad["spends"][0] = json!(hex::encode(spend));
    let body =
        json!({ "settlements": [ns[0].0.settlement_request(), bad, ns[2].0.settlement_request()] });
    let (status, answer) = sponsor.post("/v1/settlements/group", &body).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(
        answer["refused"],
        json!([{ "index": 1, "reason": "invalid" }])
    );
    assert_eq!(indexes(&answer), vec![vec![0, 2]]);
}

#[tokio::test]
async fn duplicates_and_settled_notes_are_refused_without_sending() {
    let sponsor = Sponsor::new(caps()).await;
    let ns = notes(&sponsor, 2).await;
    assert_eq!(
        sponsor
            .post("/v1/settlements", &ns[1].0.settlement_request())
            .await
            .0,
        StatusCode::OK
    );
    let (status, answer) = group(&sponsor, &[&ns[0].0, &ns[0].0, &ns[1].0]).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(
        answer["refused"],
        json!([{ "index": 1, "reason": "duplicate" }, { "index": 2, "reason": "settled" }])
    );
    assert_eq!(indexes(&answer), vec![vec![0]]);
}

/// Makes the front land a direct settlement of `note`, paid by someone else, at its trigger.
async fn arm(sponsor: &Sponsor, note: &Note) {
    let request: SettlementRequest = serde_json::from_value(note.settlement_request()).unwrap();
    let Planned::Send(job) = inspect_settlement(&sponsor.gateway, PEER_PREFIX, &request)
        .await
        .unwrap()
    else {
        panic!("the note is not settleable")
    };
    let wire = signed_v1(&sponsor.gateway.fee_payer, &job.instructions).await;
    *sponsor.racing_front().first.lock().unwrap() = Some(BASE64_STANDARD.encode(wire));
}

/// Audit M4: a simulated AlreadySettled is a race with another settlement; repacking would race again.
#[tokio::test]
async fn race_conflict_stops_repacking() {
    let front = Racing {
        inner: http(),
        at: RpcRequest::SimulateTransaction,
        first: Mutex::new(None),
    };
    let sponsor = Sponsor::on_rpc(through(front), caps()).await;
    let ns = notes(&sponsor, 3).await;
    arm(&sponsor, &ns[1].0).await;
    let fees_before = sponsor.gateway.settlements.failed_fees();
    let (status, answer) = group(&sponsor, &ns.iter().map(|n| &n.0).collect::<Vec<_>>()).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(
        answer["refused"],
        json!([
            { "index": 1, "reason": "spent" }, { "index": 0, "reason": "retry" }, { "index": 2, "reason": "retry" }
        ])
    );
    assert!(indexes(&answer).is_empty(), "repacked after a race");
    assert_eq!(
        sponsor.gateway.settlements.pending(),
        0,
        "a dropped reservation was kept"
    );
    assert_eq!(
        sponsor.gateway.settlements.failed_fees(),
        fees_before,
        "nothing failed on chain"
    );
}

#[tokio::test]
async fn one_failing_settle_note_does_not_strand_reservation_of_others() {
    let front = Racing {
        inner: http(),
        at: RpcRequest::SendTransaction,
        first: Mutex::new(None),
    };
    let sponsor = Sponsor::on_rpc(through(front), caps()).await;
    let ns = notes(&sponsor, 3).await;
    // A direct settlement of note 1 lands right before the gateway's transaction, which then fails on chain.
    arm(&sponsor, &ns[1].0).await;
    let open_before = sponsor.gateway.settlements.open_records();
    let fees_before = sponsor.gateway.settlements.failed_fees();
    let (status, answer) = group(&sponsor, &ns.iter().map(|n| &n.0).collect::<Vec<_>>()).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    // The failure is a race (AlreadySettled), so the others are answered `retry`, not repacked (audit M4).
    assert_eq!(
        answer["refused"],
        json!([
            { "index": 1, "reason": "spent" }, { "index": 0, "reason": "retry" }, { "index": 2, "reason": "retry" }
        ])
    );
    assert!(indexes(&answer).is_empty());
    assert_eq!(
        sponsor.gateway.settlements.open_records(),
        open_before,
        "a failed send left records open"
    );
    assert_eq!(
        sponsor.gateway.settlements.pending(),
        0,
        "a reservation was stranded"
    );
    assert!(
        sponsor.gateway.settlements.failed_fees() > fees_before,
        "the failed transaction's fee was not counted"
    );
    // The retried notes settle on the next request.
    let (_, again) = group(&sponsor, &[&ns[0].0, &ns[2].0]).await;
    assert_eq!(indexes(&again), vec![vec![0, 1]]);
    assert_eq!(token_balance(&ns[0].1).await, AMOUNT);
    assert_eq!(token_balance(&ns[2].1).await, AMOUNT);
}

#[tokio::test]
async fn concurrent_group_and_single_on_the_same_note_send_once() {
    let front = LostAnswers {
        inner: http(),
        lose: AtomicU32::new(0),
        sends: AtomicU32::new(0),
    };
    let sponsor = std::sync::Arc::new(Sponsor::on_rpc(through(front), caps()).await);
    let ns = notes(&sponsor, 2).await;
    let single = ns[0].0.settlement_request();
    let both = [&ns[0].0, &ns[1].0];
    let (a, b) = tokio::join!(
        group(&sponsor, &both),
        sponsor.post("/v1/settlements", &single),
    );
    assert_eq!(a.0, StatusCode::OK, "{}", a.1);
    let group_sent_0 = indexes(&a.1).concat().contains(&0);
    let single_sent = b.0 == StatusCode::OK && b.1["signature"].is_string();
    assert!(
        group_sent_0 ^ single_sent,
        "note 0 sent by both or by none: {} / {}",
        a.1,
        b.1
    );
    assert_eq!(token_balance(&ns[0].1).await, AMOUNT);
    assert_eq!(
        sponsor.gateway.settlements.failed_fees(),
        0,
        "a duplicate send failed on chain"
    );
}

#[tokio::test]
async fn two_concurrent_group_requests_send_each_note_once() {
    let front = LostAnswers {
        inner: http(),
        lose: AtomicU32::new(0),
        sends: AtomicU32::new(0),
    };
    let sponsor = Sponsor::on_rpc(through(front), caps()).await;
    let ns = notes(&sponsor, 3).await;
    let all: Vec<&Note> = ns.iter().map(|n| &n.0).collect();
    let (a, b) = tokio::join!(group(&sponsor, &all), group(&sponsor, &all));
    let sent: Vec<u64> = [indexes(&a.1).concat(), indexes(&b.1).concat()].concat();
    for i in 0..3u64 {
        assert_eq!(
            sent.iter().filter(|&&x| x == i).count(),
            1,
            "note {i}: {} / {}",
            a.1,
            b.1
        );
    }
    assert_eq!(sponsor.gateway.settlements.failed_fees(), 0);
}

#[tokio::test]
async fn group_request_counts_each_note_against_the_prefix_limit() {
    // The notes are made through another gateway: onboarding spends requests too.
    let ns = notes(&Sponsor::new(caps()).await, 3).await;
    let sponsor = Sponsor::with_requests_per_minute(caps(), 3).await;
    let (status, answer) = group(&sponsor, &ns.iter().map(|n| &n.0).collect::<Vec<_>>()).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(
        sponsor.get(PEER, "/v1/settlements/quote").await.0,
        StatusCode::TOO_MANY_REQUESTS,
        "a group of three cost one request"
    );
}

#[tokio::test]
async fn reservation_released_only_on_newer_read() {
    let front = LostAnswers {
        inner: http(),
        lose: AtomicU32::new(1),
        sends: AtomicU32::new(0),
    };
    let sponsor = Sponsor::on_rpc(through(front), caps()).await;
    let ns = notes(&Sponsor::new(caps()).await, 2).await;
    let open_before = sponsor.gateway.settlements.open_records();
    let (status, answer) = group(&sponsor, &[&ns[0].0, &ns[1].0]).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(
        indexes(&answer),
        vec![vec![0, 1]],
        "an unknown send is listed with its signature"
    );
    assert_eq!(
        sponsor.lost_front().sends.load(Ordering::SeqCst),
        1,
        "an unknown send was resent"
    );
    let records: usize = ns.iter().map(|n| n.0.record_addresses().len()).sum();
    assert_eq!(
        sponsor.gateway.settlements.open_records(),
        open_before + records
    );
    assert_eq!(sponsor.gateway.settlements.unknown_sends(), 1);
    // The janitor's next read is newer than the send: the records it finds stay, as landed.
    janitor::run_once(&sponsor.gateway, std::time::Duration::ZERO)
        .await
        .unwrap();
    assert_eq!(
        sponsor.gateway.settlements.open_records(),
        open_before + records
    );
}

#[tokio::test]
async fn group_respects_the_float_limits() {
    let mut c = float_caps();
    c.max_locks = 2;
    let sponsor = Sponsor::with_float_caps(caps(), c).await;
    let ns = notes(&sponsor, 3).await;
    let (status, answer) = group(&sponsor, &ns.iter().map(|n| &n.0).collect::<Vec<_>>()).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    assert_eq!(
        answer["refused"],
        json!([{ "index": 2, "reason": "limits:too_many_locks" }])
    );
    assert_eq!(indexes(&answer), vec![vec![0, 1]]);
}

#[tokio::test]
async fn refuses_empty_and_oversized_groups() {
    let sponsor = Sponsor::new(caps()).await;
    let ns = notes(&sponsor, 1).await;
    let nine = vec![ns[0].0.settlement_request(); 9];
    assert_eq!(
        sponsor
            .post("/v1/settlements/group", &json!({ "settlements": [] }))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        sponsor
            .post("/v1/settlements/group", &json!({ "settlements": nine }))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
}
