//! The faucet of the test mint against an Agave `solana-test-validator`: a wallet with nothing gets
//! a token account and the amount, once a day, and a gateway without a faucet says there is none.
mod support;

use axum::http::StatusCode;
use buckspay_gateway::{chain, faucet::Faucet};
use serde_json::json;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use support::*;

const AMOUNT: u64 = 20_000_000;
const PEER: &str = "203.0.113.7:4000";

fn faucet(daily: u32, per_network: u32) -> Faucet {
    Faucet::open(
        cluster().payer.insecure_clone(),
        chain::TOKEN_PROGRAM,
        AMOUNT,
        daily,
        per_network,
        None,
    )
    .unwrap()
}

async fn balance_of(wallet: &Pubkey) -> Option<u64> {
    let address = chain::associated_token_address(wallet, &cluster().mint, &chain::TOKEN_PROGRAM);
    account(&address)
        .await
        .map(|account| chain::TokenAccount::parse(&account.data).unwrap().amount)
}

#[tokio::test]
async fn a_wallet_with_nothing_gets_a_token_account_and_the_amount() {
    let sponsor = Sponsor::with_faucet(faucet(10, 10)).await;
    let wallet = Keypair::new().pubkey();
    assert_eq!(balance_of(&wallet).await, None);
    let (status, body) = sponsor
        .post_from(
            PEER,
            "/v1/faucet",
            json!({ "wallet": wallet.to_string() }).to_string(),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["amount"], AMOUNT.to_string());
    assert!(body["signature"].as_str().is_some_and(|s| s.len() > 40));
    assert_eq!(balance_of(&wallet).await, Some(AMOUNT));
}

#[tokio::test]
async fn the_same_wallet_gets_nothing_more_and_is_told_when_to_come_back() {
    let sponsor = Sponsor::with_faucet(faucet(10, 10)).await;
    let wallet = Keypair::new().pubkey().to_string();
    let body = json!({ "wallet": wallet }).to_string();
    assert_eq!(
        sponsor.post_from(PEER, "/v1/faucet", body.clone()).await.0,
        StatusCode::OK
    );
    let (status, answer) = sponsor
        .post_from("203.0.113.9:4000", "/v1/faucet", body)
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let wait = answer["retryAfter"].as_u64().unwrap();
    assert!(wait > 86_000 && wait <= 86_400, "{answer}");
}

#[tokio::test]
async fn a_network_that_used_its_claims_is_refused_for_the_day_whatever_the_wallet() {
    let sponsor = Sponsor::with_faucet(faucet(10, 1)).await;
    let ask = |wallet: Pubkey| json!({ "wallet": wallet.to_string() }).to_string();
    let (first, _) = sponsor
        .post_from(PEER, "/v1/faucet", ask(Keypair::new().pubkey()))
        .await;
    assert_eq!(first, StatusCode::OK);
    let second = Keypair::new().pubkey();
    let (status, _) = sponsor.post_from(PEER, "/v1/faucet", ask(second)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(balance_of(&second).await, None);
}

#[tokio::test]
async fn what_is_not_a_wallet_or_belongs_to_the_gateway_is_refused() {
    let sponsor = Sponsor::with_faucet(faucet(10, 10)).await;
    for wallet in ["not an address".to_owned(), sponsor.fee_payer.to_string()] {
        let (status, _) = sponsor
            .post_from(PEER, "/v1/faucet", json!({ "wallet": wallet }).to_string())
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn the_offer_names_the_amount_and_a_gateway_without_a_faucet_has_none() {
    let with = Sponsor::with_faucet(faucet(10, 10)).await;
    let (status, body) = with.get(PEER, "/v1/faucet").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["amount"], AMOUNT.to_string());
    let without = Sponsor::new(caps()).await;
    assert_eq!(
        without.get(PEER, "/v1/faucet").await.0,
        StatusCode::NOT_FOUND
    );
    let wallet = Keypair::new().pubkey().to_string();
    let (status, _) = without
        .post_from(PEER, "/v1/faucet", json!({ "wallet": wallet }).to_string())
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
