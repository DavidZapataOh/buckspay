mod support;

use axum::http::StatusCode;
use base64::{Engine, prelude::BASE64_STANDARD};
use buckspay_client::accounts::RewardConfig;
use buckspay_gateway::rewards::{self, Rate};
use solana_pubkey::Pubkey;
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

async fn leaf_values(gw: &Gw) -> Vec<u8> {
    gw.leaves(0..14)
        .await
        .iter()
        .flat_map(Leaf::value)
        .collect()
}

#[tokio::test]
async fn the_tree_endpoint_serves_every_leaf_from_index_zero() {
    let gw = start_with_rewards("10.1.12.1:4000").await;
    let (status, body) = gw.get("/v1/rewards/trees/0").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.len(), 14 * 32);
    assert_eq!(body, leaf_values(&gw).await);
}

#[tokio::test]
async fn an_unknown_epoch_is_not_found_and_a_malformed_one_is_refused() {
    let gw = start_with_rewards("10.1.12.2:4000").await;
    assert_eq!(gw.get("/v1/rewards/trees/9").await.0, StatusCode::NOT_FOUND);
    assert_eq!(
        gw.get("/v1/rewards/trees/x").await.0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn the_key_endpoint_offers_what_the_program_holds() {
    let gw = start_with_keys("10.1.12.3:4000", None, 0, Some("https://keys.example/")).await;
    let (status, body) = gw.get("/v1/rewards/key").await;
    assert_eq!(status, StatusCode::OK);
    let offer: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let config = RewardConfig::from_bytes(
        &account(&Pubkey::find_program_address(&[b"reward-config"], &program().id()).0)
            .await
            .unwrap()
            .data,
    )
    .unwrap();
    let vk = hex::encode(config.claim_key.vk);
    assert_eq!(offer["vkSha256"], vk);
    assert_eq!(offer["pkSha256"], hex::encode(config.claim_key.pk));
    assert_eq!(offer["ccsSha256"], hex::encode(config.claim_key.ccs));
    assert_eq!(offer["dumpSha256"], hex::encode(config.claim_key.dump));
    assert_eq!(
        offer["pkUrl"],
        format!("https://keys.example/zk/{vk}/pk.bin")
    );
    assert_eq!(
        offer["ccsUrl"],
        format!("https://keys.example/zk/{vk}/ccs.bin")
    );
    assert_eq!(config.rotated_at, 0);
    assert!(offer.get("previous").is_none(), "{offer}");
}

#[tokio::test]
async fn the_key_endpoint_needs_the_published_files() {
    let gw = start_with_rewards("10.1.12.4:4000").await;
    assert_eq!(gw.get("/v1/rewards/key").await.0, StatusCode::BAD_REQUEST);
}

async fn quote_of(gw: &Gw) -> serde_json::Value {
    let (status, body) = gw.get("/v1/sweeps/quote").await;
    assert_eq!(status, StatusCode::OK);
    serde_json::from_slice(&body).unwrap()
}

#[tokio::test]
async fn the_sweep_quote_states_what_the_sweep_check_enforces() {
    let gw = start_with_rewards("10.1.13.1:4000").await;
    let (quote, cfg) = (quote_of(&gw).await, gw.sweep_config());
    assert_eq!(quote["gateway"], cfg.gateway.to_string());
    assert_eq!(quote["feeAccount"], cfg.fee_account.to_string());
    assert_eq!(quote["fee"], cfg.sweep_fee.to_string());
    assert_eq!(quote["feeWithAccount"], cfg.sweep_fee_with_ata.to_string());
    assert_eq!(quote["computeUnitLimit"], cfg.pinned.sweep_cu);
    assert_eq!(
        quote["computeUnitPrice"],
        cfg.pinned.priority_price.to_string()
    );

    let number = |name: &str| quote[name].as_str().unwrap().parse::<u64>().unwrap();
    let limit = u32::try_from(quote["computeUnitLimit"].as_u64().unwrap()).unwrap();
    let (fresh, to) = (fresh_keypair("quote"), fresh_keypair("quote-to").pubkey());
    let built = gw
        .sweep_body_with(
            &fresh,
            &to,
            1_000_000,
            number("feeWithAccount"),
            (limit, number("computeUnitPrice")),
        )
        .await;
    let body: serde_json::Value = serde_json::from_str(&built).unwrap();
    let bytes = BASE64_STANDARD
        .decode(body["transaction"].as_str().unwrap())
        .unwrap();
    let tx: solana_transaction::versioned::VersionedTransaction =
        bincode::deserialize(&bytes).unwrap();
    rewards::check_sweep(&tx, &cfg).unwrap();

    let sent = gw.sent_transactions().await;
    for pinned in [
        (limit + 1, number("computeUnitPrice")),
        (limit, number("computeUnitPrice") + 1),
    ] {
        let other = gw
            .sweep_body_with(&fresh, &to, 1_000_000, number("feeWithAccount"), pinned)
            .await;
        let answer = gw.post_raw("/v1/sweeps", other).await;
        assert_eq!(
            (answer.status.as_str(), answer.reason.as_deref()),
            ("refused", Some("invalid"))
        );
    }
    assert_eq!(gw.sent_transactions().await, sent);
}

#[tokio::test]
async fn the_sweep_quote_needs_a_rate() {
    let gw = start_with("10.1.13.2:4000", None).await;
    assert_eq!(gw.get("/v1/sweeps/quote").await.0, StatusCode::BAD_REQUEST);
}
