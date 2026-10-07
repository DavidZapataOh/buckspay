//! Delivery words against the validator that runs the short-windows build: the word of a settled
//! relayed payment goes to the first relayer that posted it, and a relayer settles the words it
//! holds through `POST /v1/channels`.
mod support;

use axum::http::StatusCode;
use buckspay_gateway::{channels::Channels, relay::Relay};
use serde_json::Value;
use std::time::Instant;
use support::{channels::*, *};

const PEER: &str = "203.0.113.1";

async fn instant() -> Sponsor {
    gateway(Relay::with_delay(0), Channels::default()).await
}

/// A gateway that holds every relayed payment back for a long while.
async fn slow() -> Sponsor {
    gateway(Relay::with_delay(1_000_000), Channels::default()).await
}

fn released(sponsor: &Sponsor, payer: &Payer) -> usize {
    sponsor.gateway.words.released_for(&payer.channel_hash())
}

#[tokio::test]
async fn the_first_relayer_gets_the_word_and_the_second_gets_nothing() {
    let gw = instant().await;
    let mut payer = Payer::standard(&gw).await;
    let blob = payer.tip(0).await;
    let (first, second) = (rk(), rk());
    assert_eq!(
        post_with_rk(&gw, PEER, &blob, Some(&first)).await,
        "submitted"
    );
    assert_eq!(
        post_with_rk(&gw, "198.51.100.2", &blob, Some(&second)).await,
        "duplicate"
    );
    let sealed = sealed_word(&gw, &blob.id).await;
    assert!(first.open_word(&sealed).is_some());
    assert!(second.open_word(&sealed).is_none());
    assert_eq!(token_balance(&payer.payee.token).await, 2_000_000);
}

#[tokio::test]
async fn no_word_before_settlement_and_gone_when_the_job_ends_unsettled() {
    let gw = slow().await;
    let mut payer = Payer::standard(&gw).await;
    let blob = payer.tip(0).await;
    assert_eq!(
        post_with_rk(&gw, PEER, &blob, Some(&rk())).await,
        "submitted"
    );
    assert_eq!(word_status(&gw, &blob.id).await, StatusCode::NOT_FOUND);
    assert_eq!(released(&gw, &payer), 0);
    let dead = payer.payment(Some(1), -600).await;
    let answer = post_with_rk(&gw, PEER, &dead, Some(&rk())).await;
    assert_eq!(answer, "refused");
    assert_eq!(until_final(&gw, &dead.id).await, StatusCode::GONE);
}

#[tokio::test]
async fn a_payment_without_a_relayer_key_settles_and_releases_nothing() {
    let gw = instant().await;
    let mut payer = Payer::standard(&gw).await;
    let blob = payer.tip(0).await;
    assert_eq!(post_with_rk(&gw, PEER, &blob, None).await, "submitted");
    for _ in 0..120 {
        if token_balance(&payer.payee.token).await == 2_000_000 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    assert_eq!(token_balance(&payer.payee.token).await, 2_000_000);
    assert_eq!(word_status(&gw, &blob.id).await, StatusCode::NOT_FOUND);
    assert_eq!(released(&gw, &payer), 0);
}

#[tokio::test]
async fn a_reused_index_is_released_once() {
    let gw = instant().await;
    let mut payer = Payer::standard(&gw).await;
    let (a, b) = (payer.tip(2).await, payer.tip(2).await);
    let first = rk();
    assert_eq!(post_with_rk(&gw, PEER, &a, Some(&first)).await, "submitted");
    sealed_word(&gw, &a.id).await;
    assert_eq!(post_with_rk(&gw, PEER, &b, Some(&rk())).await, "submitted");
    assert_eq!(until_final(&gw, &b.id).await, StatusCode::GONE);
    assert_eq!(released(&gw, &payer), 1);
}

#[tokio::test]
async fn no_word_is_released_when_the_lock_cannot_cover_it() {
    let gw = instant().await;
    // The backing holds the channel's interval, and what the two notes leave is less than a word.
    let mut payer = Payer::new(&gw, BOND, 8_300_000).await;
    let big = payer.payment_of(6_000_000, None, 600).await;
    assert_eq!(post_with_rk(&gw, PEER, &big, None).await, "submitted");
    for _ in 0..120 {
        if token_balance(&payer.payee.token).await == 6_000_000 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    assert_eq!(token_balance(&payer.payee.token).await, 6_000_000);
    let blob = payer.tip(0).await;
    assert_eq!(
        post_with_rk(&gw, PEER, &blob, Some(&rk())).await,
        "submitted"
    );
    assert_eq!(until_final(&gw, &blob.id).await, StatusCode::GONE);
    assert_eq!(token_balance(&payer.payee.token).await, 8_000_000);
    assert_eq!(released(&gw, &payer), 0);
}

#[tokio::test]
async fn relayer_settles_six_words_of_two_payers_in_one_transaction() {
    let gw = instant().await;
    let mut relayer = Relayer::default();
    for _ in 0..2 {
        let mut payer = Payer::standard(&gw).await;
        for index in 0..3 {
            let blob = payer.tip(index).await;
            relayer.deliver(&gw, PEER, &blob).await;
        }
    }
    let batch = relayer.batch(0, 6);
    let started = Instant::now();
    let answer = post_channels(&gw, PEER, &batch).await;
    assert_eq!(answer["status"], "submitted", "{answer}");
    let done = until_batch_ends(&gw, answer["jobKey"].as_str().unwrap()).await;
    assert_eq!(done["status"], "settled", "{done}");
    assert_eq!(done["leafIndexes"].as_array().unwrap().len(), 2);
    eprintln!(
        "words=6 leaves=2 tx=1 cu={} bytes={} in {} ms",
        done["computeUnits"],
        done["bytes"],
        started.elapsed().as_millis()
    );
    let replay = post_channels(&gw, PEER, &batch).await;
    assert_eq!(replay["status"], "refused", "{replay}");
    assert_eq!(replay["reason"], "settled");
}

#[tokio::test]
async fn channels_endpoint_refuses_before_spending_when_limits_or_bits_say_no() {
    let gw = instant().await;
    let mut relayer = Relayer::default();
    let mut payer = Payer::standard(&gw).await;
    for index in 0..2 {
        let blob = payer.tip(index).await;
        relayer.deliver(&gw, "198.51.100.9", &blob).await;
    }
    let batch = relayer.batch(0, 2);
    let landed = post_channels(&gw, "198.51.100.9", &batch).await;
    until_batch_ends(&gw, landed["jobKey"].as_str().unwrap()).await;
    let lamports = balance(&gw.fee_payer).await;
    let again = post_channels(&gw, "198.51.100.9", &batch).await;
    assert_eq!(
        (again["status"].clone(), again["reason"].clone()),
        ("refused".into(), "settled".into())
    );
    let garbage: Value = serde_json::json!({ "channels": [], "inners": [] });
    let mut answers = vec![];
    for _ in 0..70 {
        answers.push(post_channels(&gw, "203.0.113.77", &garbage).await["status"].clone());
    }
    assert_eq!(answers[0], "refused");
    assert_eq!(
        answers[69], "retry",
        "the limits answer before anything is read"
    );
    assert_eq!(balance(&gw.fee_payer).await, lamports, "nothing was spent");
}

#[tokio::test]
async fn new_channels_are_capped_per_network_and_globally() {
    let channels = Channels::new(3, 2, Default::default());
    let gw = gateway(Relay::with_delay(0), channels).await;
    let mut relayer = Relayer::default();
    for _ in 0..4 {
        let mut payer = Payer::standard(&gw).await;
        for index in 0..2 {
            let blob = payer.tip(index).await;
            relayer.deliver(&gw, "198.51.100.9", &blob).await;
        }
    }
    let ends = |answer: &Value| answer["jobKey"].as_str().unwrap().to_owned();
    for at in [0, 2] {
        let answer = post_channels(&gw, "10.0.0.1", &relayer.batch(at, 2)).await;
        assert_eq!(answer["status"], "submitted", "{answer}");
        assert_eq!(
            until_batch_ends(&gw, &ends(&answer)).await["status"],
            "settled"
        );
    }
    let spare = relayer.batch(4, 2);
    assert_eq!(
        post_channels(&gw, "10.0.0.1", &spare).await["status"],
        "retry"
    );
    let second = post_channels(&gw, "10.0.2.1", &relayer.batch(6, 2)).await;
    assert_eq!(second["status"], "submitted", "{second}");
    assert_eq!(
        post_channels(&gw, "10.0.3.1", &spare).await["status"],
        "retry"
    );
    until_batch_ends(&gw, &ends(&second)).await;
}
