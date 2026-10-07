mod support;

use base64::{Engine, prelude::BASE64_STANDARD};
use buckspay_gateway::rewards::{self, Rate};
use solana_signer::Signer;
use support::{rewards::*, *};

fn flip(mut body: rewards::ClaimBody) -> rewards::ClaimBody {
    let mut proof = BASE64_STANDARD.decode(&body.claims[0].proof).unwrap();
    proof[9] ^= 1;
    body.claims[0].proof = BASE64_STANDARD.encode(proof);
    body
}

#[tokio::test]
async fn claim_to_a_zero_sol_wallet_lands_and_repeats_are_duplicate() {
    let gw = start_with_rewards("10.1.1.1:4000").await;
    let fresh = fresh_keypair("zero-sol");
    let body = claim_body(&[gw.leaf(1).await], &fresh.pubkey()).await;
    let answer = gw.post_claims(&body).await;
    assert_eq!(answer.status, "submitted");
    let done = gw.until_settled(&answer.job_key.unwrap()).await;
    assert_eq!(done.status, "settled", "{done:?}");
    assert!(done.signature.is_some());
    println!("claim_units={}", done.compute_units.unwrap());
    assert_eq!(gw.lamports(&fresh.pubkey()).await, 0);
    assert_eq!(
        gw.token_balance_of(&fresh.pubkey()).await,
        4 * UNIT - CLAIM_FEE
    );
    assert_eq!(gw.post_claims(&body).await.status, "duplicate");
    assert_eq!(gw.post_claims(&flip(body)).await.status, "duplicate");
}

#[tokio::test]
async fn invalid_proof_is_refused_without_sending() {
    let gw = start_with_rewards("10.1.2.1:4000").await;
    let body = flip(claim_body(&[gw.leaf(2).await], &fresh_keypair("invalid").pubkey()).await);
    let (before, sent) = (gw.fee_payer_lamports().await, gw.sent_transactions().await);
    let answer = gw.post_claims(&body).await;
    assert_eq!(
        (answer.status.as_str(), answer.reason.as_deref()),
        ("refused", Some("invalid"))
    );
    assert_eq!(gw.fee_payer_lamports().await, before);
    assert_eq!(gw.sent_transactions().await, sent);
}

#[tokio::test]
async fn spent_nullifier_is_refused_before_native_verification() {
    let gw = start_with_rewards("10.1.3.1:4000").await;
    let (leaf, owner) = (gw.leaf(3).await, fresh_keypair("spent"));
    gw.claim_directly_on_chain(&leaf, &owner).await;
    let verifications = gw.native_verifications();
    let answer = gw
        .post_claims(&claim_body(&[leaf], &owner.pubkey()).await)
        .await;
    assert_eq!(answer.reason.as_deref(), Some("spent"), "{answer:?}");
    assert_eq!(gw.native_verifications(), verifications);
}

#[tokio::test]
async fn rate_limit_is_checked_before_native_verification() {
    let gw = start_with_rewards("10.1.4.1:4000").await;
    let body = flip(claim_body(&[gw.leaf(2).await], &fresh_keypair("invalid").pubkey()).await);
    let before = gw.native_verifications();
    for _ in 0..CLAIM_IP_LIMIT {
        assert_eq!(
            gw.post_claims(&body).await.reason.as_deref(),
            Some("invalid")
        );
    }
    let verifications = gw.native_verifications();
    assert_eq!(verifications - before, u64::from(CLAIM_IP_LIMIT));
    assert_eq!(gw.post_claims(&body).await.status, "retry");
    assert_eq!(gw.native_verifications(), verifications);
}

#[tokio::test]
async fn a_different_fee_ceiling_is_refused() {
    let gw = start_with_rewards("10.1.5.1:4000").await;
    let mut body = claim_body(&[gw.leaf(2).await], &fresh_keypair("invalid").pubkey()).await;
    body.max_fee -= 1;
    let verifications = gw.native_verifications();
    let answer = gw.post_claims(&body).await;
    assert_eq!(answer.reason.as_deref(), Some("fee"), "{answer:?}");
    assert_eq!(gw.native_verifications(), verifications);
}

#[tokio::test]
async fn claim_never_costs_the_sponsor_more_than_it_pays() {
    let gw = start_with_rewards("10.1.6.1:4000").await;
    let mut next = 4;
    for k in 1..=rewards::MAX_CLAIMS_PER_TX {
        let leaves = gw.leaves(next..next + k).await;
        next += k;
        let fresh = fresh_keypair(&format!("cost-{k}"));
        let (fee_before, lamports_before) = (
            gw.fee_account_balance().await,
            gw.fee_payer_lamports().await,
        );
        let body = claim_body(&leaves, &fresh.pubkey()).await;
        let answer = gw
            .post_claims_as(&format!("10.{}.6.1:4000", 20 + k), &body)
            .await;
        assert_eq!(answer.status, "submitted", "{answer:?}");
        let done = gw.until_settled(&answer.job_key.unwrap()).await;
        assert_eq!(done.status, "settled", "{done:?}");
        let spent = lamports_before - gw.fee_payer_lamports().await;
        let repaid = gw.fee_account_balance().await - fee_before;
        assert!(
            gw.rate().lamports_to_usdc(spent) <= repaid,
            "k={k}: spent {spent} lamports, repaid {repaid}"
        );
        println!(
            "claims={k} lamports={spent} units={}",
            done.compute_units.unwrap()
        );
    }
}

#[tokio::test]
async fn gateway_refuses_to_start_when_the_on_chain_claim_fee_is_below_cost() {
    let gw = start_with("10.1.7.1:4000", Some(Rate::per_sol(400_000_000))).await;
    let error = rewards::check_economics(&gw.sponsor.gateway)
        .await
        .unwrap_err();
    assert!(error.contains("claim_fee"), "{error}");
    let gw = start_with_rewards("10.1.7.2:4000").await;
    rewards::check_economics(&gw.sponsor.gateway).await.unwrap();
}

#[tokio::test]
async fn sweep_moves_rewards_and_charges_the_fee() {
    let gw = start_with_rewards("10.1.8.1:4000").await;
    let (fresh, to) = (fresh_keypair("sweep"), fresh_keypair("sweep-to").pubkey());
    let answer = gw
        .post_claims(&claim_body(&[gw.leaf(0).await], &fresh.pubkey()).await)
        .await;
    gw.until_settled(&answer.job_key.unwrap()).await;
    let balance = gw.token_balance_of(&fresh.pubkey()).await;
    assert_eq!(balance, 8 * UNIT - CLAIM_FEE);
    let fee = gw.sweep_config().sweep_fee_with_ata;
    let sent = gw.sent_transactions().await;
    let low = gw.sweep_body(&fresh, &to, balance - fee + 1, fee - 1).await;
    let refused = gw.post_raw("/v1/sweeps", low).await;
    assert_eq!(
        (refused.status.as_str(), refused.reason.as_deref()),
        ("refused", Some("invalid"))
    );
    assert_eq!(gw.sent_transactions().await, sent);
    let body = gw.sweep_body(&fresh, &to, balance - fee, fee).await;
    let another = gw.sweep_body(&fresh, &to, balance - fee - 1, fee).await;
    let answer = gw.post_raw("/v1/sweeps", body.clone()).await;
    assert_eq!(answer.status, "submitted", "{answer:?}");
    assert_eq!(gw.post_raw("/v1/sweeps", another).await.status, "duplicate");
    let done = gw.until_settled(&answer.job_key.unwrap()).await;
    assert_eq!(done.status, "settled", "{done:?}");
    assert_eq!(gw.token_balance_of(&to).await, balance - fee);
    assert_eq!(gw.token_balance_of(&fresh.pubkey()).await, 0);
    assert_eq!(token_balance(&gw.fee_account).await, fee);
    assert_eq!(gw.lamports(&fresh.pubkey()).await, 0);
    assert_eq!(gw.post_raw("/v1/sweeps", body).await.status, "duplicate");
}

#[tokio::test]
async fn the_daily_budget_bounds_what_the_gateway_pays() {
    let gw = start_with_budget("10.1.9.1:4000", Some(gw_rate()), 1_000_000).await;
    let body = claim_body(&[gw.leaf(2).await], &fresh_keypair("invalid").pubkey()).await;
    let (before, sent) = (gw.fee_payer_lamports().await, gw.sent_transactions().await);
    assert_eq!(gw.post_claims(&body).await.status, "retry");
    assert_eq!(gw.fee_payer_lamports().await, before);
    assert_eq!(gw.sent_transactions().await, sent);
}

#[tokio::test]
async fn rewards_without_a_rate_answer_retry() {
    let gw = start_with("10.1.10.1:4000", None).await;
    let body = claim_body(&[gw.leaf(2).await], &fresh_keypair("invalid").pubkey()).await;
    assert_eq!(gw.post_claims(&body).await.status, "retry");
}

fn gw_rate() -> Rate {
    Rate::per_sol(SOL_PRICE_MICRO_USDC)
}

#[tokio::test]
async fn a_claim_that_does_not_repay_its_cost_at_the_rate_is_refused() {
    let gw = start_with("10.1.11.1:4000", Some(Rate::per_sol(400_000_000))).await;
    let body = claim_body(&[gw.leaf(2).await], &fresh_keypair("invalid").pubkey()).await;
    let (before, sent) = (gw.fee_payer_lamports().await, gw.sent_transactions().await);
    let answer = gw.post_claims(&body).await;
    assert_eq!(answer.reason.as_deref(), Some("fee"), "{answer:?}");
    assert_eq!(gw.fee_payer_lamports().await, before);
    assert_eq!(gw.sent_transactions().await, sent);
}
