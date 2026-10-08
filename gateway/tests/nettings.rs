//! Sponsored netting records against the validator that runs the short-windows build: everything is checked
//! before the gateway spends, the caps bound the sponsor, a capped member records paying itself, and the janitor
//! takes the rent back.
mod support;

use axum::http::StatusCode;
use buckspay_gateway::{
    janitor,
    nettings::{self, NettingCaps},
};
use buckspay_protocol::netting::NettingStatement;
use serde_json::{Value, json};
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use std::{sync::atomic::AtomicU32, time::Duration};
use support::{netting::*, zk, *};

async fn sponsor(caps: NettingCaps) -> Sponsor {
    zk::configure().await;
    Sponsor::with_nettings(caps).await
}

async fn post(s: &Sponsor, body: &Value) -> (StatusCode, Value) {
    s.post("/v1/nettings", body).await
}

#[tokio::test]
async fn records_a_valid_netting_and_answers_409_on_repeat() {
    let _g = serial().await;
    let s = sponsor(wide()).await;
    let measured: Option<u8> = std::env::var("NETTING_N").ok().and_then(|n| n.parse().ok());
    let (st, proof) = match measured {
        Some(n) => {
            let f = fixture(n);
            (f.statement, f.proof)
        }
        None => fresh().await,
    };
    let before = balance(&s.fee_payer).await;
    let (status, body) = post(&s, &request(&st, &proof)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    if let Some(n) = measured {
        let rent = rpc(&cluster().url)
            .get_minimum_balance_for_rent_exemption(48)
            .await
            .unwrap();
        let spent = before - balance(&s.fee_payer).await;
        let cu = units_of(body["signature"].as_str().unwrap()).await;
        println!("M9 n={n} fee_lamports={} rent={rent} cu={cu}", spent - rent);
    }
    let record = account(&netting_address(&st.content()))
        .await
        .expect("recorded");
    assert_eq!(&record.data[8..40], s.fee_payer.as_ref());
    let (status, body) = post(&s, &request(&st, &proof)).await;
    assert_eq!(
        (status, body["reason"].as_str()),
        (StatusCode::CONFLICT, Some("recorded"))
    );
}

#[tokio::test]
async fn refuses_invalid_netting_before_any_send() {
    let _g = serial().await;
    let s = sponsor(wide()).await;
    let (st, proof) = fresh().await;
    let resigned = |f: &dyn Fn(&mut NettingStatement)| {
        let mut t = st;
        f(&mut t);
        request(&t, &proof)
    };
    let (expired, curve) = (named("expired"), named("on_curve_short"));
    let honest = request(&st, &proof);
    let mut cases: Vec<(&str, Value, &str)> = vec![
        ("total", resigned(&|t| t.total += 1), "proof"),
        (
            "replay_under_other_expires",
            resigned(&|t| t.expires -= 1),
            "proof",
        ),
        (
            "replay_under_other_mint",
            resigned(&|t| t.mint[0] ^= 1),
            "proof",
        ),
        (
            "root",
            resigned(&|t| t.root = fixture(8).statement.root),
            "proof",
        ),
        ("session", resigned(&|t| t.session[0] ^= 1), "proof"),
        ("participants", resigned(&|t| t.participants -= 1), "proof"),
        (
            "expired",
            request(&expired.statement, &expired.proof),
            "expired",
        ),
        (
            "noncanonical_root",
            resigned(&|t| t.root = buckspay_zk_verify::fr::MODULUS),
            "statement",
        ),
        (
            "on_curve",
            request(&curve.statement, &curve.proof),
            "address",
        ),
        (
            "note_domain",
            request_under(&st, &proof, &note_domain()),
            "signatures",
        ),
    ];
    let mut mint = honest.clone();
    let mut m = st;
    m.mint[0] ^= 1;
    mint["statement"] = json!(hex::encode(body_of(&m)));
    cases.push(("mint_with_the_original_signatures", mint, "signatures"));
    let mut missing = honest.clone();
    missing["signatures"].as_array_mut().unwrap().pop();
    cases.push(("missing_signature", missing, "signatures"));
    let mut swapped = honest.clone();
    swapped["signatures"].as_array_mut().unwrap().swap(0, 1);
    cases.push(("reordered_signatures", swapped, "signatures"));
    let mut flipped = honest.clone();
    let mut p = proof;
    p[100] ^= 1;
    flipped["proof"] = json!(hex::encode(p));
    cases.push(("proof_bit_flip", flipped, "proof"));
    let mut short = honest.clone();
    let mut b = body_of(&st);
    b.pop();
    short["statement"] = json!(hex::encode(b));
    cases.push(("truncated_statement", short, "statement"));
    let before = balance(&s.fee_payer).await;
    for (name, body, reason) in cases {
        let (status, answer) = post(&s, &body).await;
        assert_eq!(
            (status, answer["reason"].as_str()),
            (StatusCode::BAD_REQUEST, Some(reason)),
            "{name}: {answer}"
        );
    }
    assert_eq!(
        balance(&s.fee_payer).await,
        before,
        "the sponsor paid for a refused netting"
    );
    assert!(account(&netting_address(&st.content())).await.is_none());
}

#[tokio::test]
async fn records_while_zk_paused() {
    let _g = serial().await;
    let s = sponsor(wide()).await;
    zk::set_paused(true).await;
    let (st, proof) = fresh().await;
    let answer = post(&s, &request(&st, &proof)).await;
    zk::set_paused(false).await;
    assert_eq!(answer.0, StatusCode::OK, "{}", answer.1);
}

async fn quote(s: &Sponsor) -> (u64, Pubkey, String) {
    let (status, q) = s.get(PEER, "/v1/nettings/quote").await;
    assert_eq!(status, StatusCode::OK, "{q}");
    (
        q["lamports"].as_u64().unwrap(),
        q["sponsor"].as_str().unwrap().parse().unwrap(),
        q["quoteId"].as_str().unwrap().to_owned(),
    )
}

fn memo(s: &NettingStatement, quote_id: &str) -> String {
    format!("{}:{quote_id}", hex::encode(s.content()))
}

#[tokio::test]
async fn paid_lane_records_past_the_free_cap() {
    let _g = serial().await;
    let s = sponsor(NettingCaps { daily: 1, ..wide() }).await;
    let (a, pa) = fresh().await;
    let (b, pb) = fresh().await;
    assert_eq!(post(&s, &request(&a, &pa)).await.0, StatusCode::OK);
    let (status, body) = post(&s, &request(&b, &pb)).await;
    assert_eq!(
        (status, body["reason"].as_str()),
        (StatusCode::TOO_MANY_REQUESTS, Some("cap"))
    );
    let (lamports, to, q) = quote(&s).await;
    assert_eq!(to, s.fee_payer);
    let payment = pay(&to, lamports, &memo(&b, &q)).await;
    let (status, body) = post(&s, &paid(&b, &pb, &payment)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(account(&netting_address(&b.content())).await.is_some());
    assert_eq!(
        s.gateway.nettings.sent_today(chain_now().await),
        1,
        "the paid lane took a free slot"
    );
}

#[tokio::test]
async fn paid_lane_refuses_a_reused_payment() {
    let _g = serial().await;
    let s = sponsor(NettingCaps { daily: 0, ..wide() }).await;
    let (a, pa) = fresh().await;
    let (b, pb) = fresh().await;
    let (lamports, to, q) = quote(&s).await;
    let payment = pay(&to, lamports, &memo(&a, &q)).await;
    assert_eq!(post(&s, &paid(&a, &pa, &payment)).await.0, StatusCode::OK);
    let before = balance(&s.fee_payer).await;
    let (status, body) = post(&s, &paid(&b, &pb, &payment)).await;
    assert_eq!(
        (status, body["reason"].as_str()),
        (StatusCode::BAD_REQUEST, Some("payment"))
    );
    assert!(account(&netting_address(&b.content())).await.is_none());
    assert_eq!(balance(&s.fee_payer).await, before);
}

#[tokio::test]
async fn paid_lane_refuses_wrong_memo_or_amount() {
    let _g = serial().await;
    let s = sponsor(NettingCaps { daily: 0, ..wide() }).await;
    let (st, proof) = fresh().await;
    let (lamports, to, q) = quote(&s).await;
    let content = memo(&st, &q);
    let other = solana_pubkey::Pubkey::new_unique();
    for (name, payment) in [
        ("short", pay(&to, lamports - 1, &content).await),
        (
            "memo",
            pay(&to, lamports, &format!("{}:{q}", hex::encode([7u8; 32]))).await,
        ),
        ("recipient", pay(&other, lamports, &content).await),
        (
            "unknown_quote",
            pay(&to, lamports, &memo(&st, "q-never-issued")).await,
        ),
    ] {
        let (status, body) = post(&s, &paid(&st, &proof, &payment)).await;
        assert_eq!(
            (status, body["reason"].as_str()),
            (StatusCode::BAD_REQUEST, Some("payment")),
            "{name}"
        );
    }
    assert!(account(&netting_address(&st.content())).await.is_none());
}

#[tokio::test]
async fn paid_lane_honours_the_quote_it_paid() {
    let _g = serial().await;
    let s = sponsor(NettingCaps {
        daily: 0,
        quote_ttl: 2,
        ..wide()
    })
    .await;
    let (st, proof) = fresh().await;
    let (lamports, to, q) = quote(&s).await;
    tokio::time::sleep(Duration::from_secs(4)).await;
    let late = pay(&to, lamports, &memo(&st, &q)).await;
    let (status, body) = post(&s, &paid(&st, &proof, &late)).await;
    assert_eq!(
        (status, body["reason"].as_str()),
        (StatusCode::BAD_REQUEST, Some("payment")),
        "paid after the quote expired"
    );
    let (lamports, to, q) = quote(&s).await;
    let on_time = pay(&to, lamports, &memo(&st, &q)).await;
    assert_eq!(
        post(&s, &paid(&st, &proof, &on_time)).await.0,
        StatusCode::OK,
        "the quote's own amount is honoured"
    );
}

#[tokio::test]
async fn paid_lane_retry_for_the_same_content_after_a_failed_send() {
    let _g = serial().await;
    zk::configure().await;
    let caps = NettingCaps { daily: 0, ..wide() };
    let lossy = Sponsor::with_nettings_on(
        through(Dropping {
            inner: http(),
            drop: AtomicU32::new(1),
        }),
        caps.clone(),
    )
    .await;
    let (st, proof) = fresh().await;
    let (lamports, to, q) = quote(&lossy).await;
    let payment = pay(&to, lamports, &memo(&st, &q)).await;
    assert_eq!(
        post(&lossy, &paid(&st, &proof, &payment)).await.0,
        StatusCode::ACCEPTED,
        "the first send never reached Solana: outcome unknown"
    );
    assert!(account(&netting_address(&st.content())).await.is_none());
    let (status, body) = post(&lossy, &paid(&st, &proof, &payment)).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "same content, no record: the payment may retry: {body}"
    );
}

#[tokio::test]
async fn a_prefunded_address_is_not_a_record() {
    let _g = serial().await;
    let s = sponsor(wide()).await;
    let (st, proof) = fresh().await;
    zk::airdrop(&netting_address(&st.content()), 5_000_000).await;
    let (status, body) = post(&s, &request(&st, &proof)).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a system account at the address answered 409: {body}"
    );
    let (status, _) = post(&s, &request(&st, &proof)).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "only a real record answers 409"
    );
}

#[tokio::test]
async fn ipv6_prefixes_aggregate_per_48() {
    let _g = serial().await;
    let s = sponsor(NettingCaps {
        ip_hourly: 2,
        ..wide()
    })
    .await;
    let (st, mut proof) = fresh().await;
    proof[100] ^= 1;
    let body = request(&st, &proof).to_string();
    for k in 1..=2 {
        let peer = format!("[2001:db8:7:{k}::1]:4000");
        assert_eq!(
            s.post_from(&peer, "/v1/nettings", body.clone()).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    let (status, answer) = s
        .post_from("[2001:db8:7:ffff::9]:4000", "/v1/nettings", body.clone())
        .await;
    assert_eq!(
        (status, answer["reason"].as_str()),
        (StatusCode::TOO_MANY_REQUESTS, Some("ip")),
        "another /64 of the same /48"
    );
    assert_eq!(
        s.post_from("[2001:db8:8:1::1]:4000", "/v1/nettings", body)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn member_paid_v1_record_lands() {
    let _g = serial().await;
    let (b, proof) = fresh().await;
    let member = funded(100_000_000).await;
    let ixs = nettings::record_instructions(
        &program().id(),
        &netting_domain(),
        &member.pubkey(),
        &body_of(&b),
        &signatures(&b),
        &proof,
    );
    send_v1_as(&member, &ixs).await;
    let record = account(&netting_address(&b.content()))
        .await
        .expect("the member recorded it");
    assert_eq!(&record.data[8..40], member.pubkey().as_ref());
}

#[tokio::test]
async fn ip_limit_returns_429_before_native_verification() {
    let _g = serial().await;
    let s = sponsor(NettingCaps {
        ip_hourly: 2,
        ..wide()
    })
    .await;
    let (st, mut proof) = fresh().await;
    proof[100] ^= 1;
    let body = request(&st, &proof).to_string();
    for _ in 0..2 {
        assert_eq!(
            s.post_from("10.7.1.1:4000", "/v1/nettings", body.clone())
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let verified = s.gateway.nettings.verified();
    let (status, answer) = s
        .post_from("10.7.1.200:4000", "/v1/nettings", body.clone())
        .await;
    assert_eq!(
        (status, answer["reason"].as_str()),
        (StatusCode::TOO_MANY_REQUESTS, Some("ip"))
    );
    assert_eq!(
        s.gateway.nettings.verified(),
        verified,
        "verified after the limit"
    );
    assert_eq!(
        s.post_from("10.7.2.1:4000", "/v1/nettings", body).await.0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn a_cap_slot_is_written_before_the_send_and_survives_a_restart() {
    let _g = serial().await;
    let caps = NettingCaps { daily: 2, ..wide() };
    zk::configure().await;
    let front = LostAnswers {
        inner: http(),
        lose: AtomicU32::new(1),
        sends: AtomicU32::new(0),
    };
    let lost = Sponsor::with_nettings_on(through(front), caps.clone()).await;
    let (a, pa) = fresh().await;
    let (status, body) = post(&lost, &request(&a, &pa)).await;
    assert_eq!(
        (status, &body["pending"]),
        (StatusCode::ACCEPTED, &json!(true)),
        "{body}"
    );
    drop(lost);
    let again = Sponsor::with_nettings(caps).await;
    assert_eq!(again.gateway.nettings.sent_today(chain_now().await), 1);
    let (b, pb) = fresh().await;
    assert_eq!(post(&again, &request(&b, &pb)).await.0, StatusCode::OK);
    let (c, pc) = fresh().await;
    assert_eq!(
        post(&again, &request(&c, &pc)).await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
}

/// End to end the janitor can only be shown to leave a record open: `closable_at = expires + KEEP` and every
/// fixture's `expires` is fixed by its proof (QUESTIONS CONFLICT 5); the closing itself is the unit test
/// `janitor_selects_nettings_past_closable_at` plus the program's LiteSVM close test.
#[tokio::test]
async fn janitor_leaves_records_open_before_closable_at() {
    let _g = serial().await;
    let s = sponsor(wide()).await;
    let (st, proof) = fresh().await;
    assert_eq!(post(&s, &request(&st, &proof)).await.0, StatusCode::OK);
    let report = janitor::run_once(&s.gateway, Duration::ZERO).await.unwrap();
    assert_eq!(report.nettings_closed, 0);
    let data = account(&netting_address(&st.content()))
        .await
        .expect("closed early")
        .data;
    assert_eq!(
        u32::from_le_bytes(data[44..48].try_into().unwrap()),
        st.expires + 120,
        "short-windows keep"
    );
}

#[tokio::test]
async fn key_offer_serves_the_configured_netting_key() {
    let s = sponsor(wide()).await;
    let (status, body) = s.get(PEER, "/v1/nettings/key").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let vk = hex::encode(buckspay_zk_verify::vk::NETTING_VK.sha256);
    assert_eq!(body["vkSha256"], json!(vk));
    assert!(
        body["pkUrl"]
            .as_str()
            .unwrap()
            .ends_with(&format!("/zk/{vk}/pk.bin"))
    );
}

#[test]
fn record_instruction_vector_is_current() {
    let f = fixture(5);
    let payer = solana_pubkey::Pubkey::new_from_array([0x11; 32]);
    let sigs = signatures(&f.statement);
    let ixs = nettings::record_instructions(
        &program().id(),
        &netting_domain(),
        &payer,
        &body_of(&f.statement),
        &sigs,
        &f.proof,
    );
    let got = json!({
        "programId": program().id().to_string(),
        "programIdHex": hex::encode(program().id().to_bytes()),
        "payer": payer.to_string(),
        "statement": hex::encode(body_of(&f.statement)),
        "signatures": sigs.iter().map(hex::encode).collect::<Vec<_>>(),
        "proof": hex::encode(f.proof),
        "two": {
            "statement": hex::encode(body_of(&fixture(2).statement)),
            "signatures": signatures(&fixture(2).statement).iter().map(hex::encode).collect::<Vec<_>>(),
            "proof": hex::encode(fixture(2).proof),
        },
        "instructions": ixs.iter().map(|ix| json!({
            "programId": ix.program_id.to_string(),
            "accounts": ix.accounts.iter().map(|a| json!({ "pubkey": a.pubkey.to_string(), "isSigner": a.is_signer, "isWritable": a.is_writable })).collect::<Vec<_>>(),
            "data": hex::encode(&ix.data),
        })).collect::<Vec<_>>(),
    });
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/vectors/netting_record.json"
    );
    if std::env::var_os("UPDATE_VECTORS").is_some() {
        std::fs::write(path, serde_json::to_string_pretty(&got).unwrap() + "\n").unwrap();
    }
    let want: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(got, want);
}
