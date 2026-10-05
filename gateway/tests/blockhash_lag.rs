//! A sponsored send whose preflight lands on an RPC node that has not seen the blockhash yet, as on
//! a load-balanced public RPC: the gateway retries it briefly and otherwise asks to try again.
mod support;

use async_trait::async_trait;
use axum::http::StatusCode;
use buckspay_gateway::{float::SettlementLimits, server::ClientAddress, sponsor::SponsorLimits};
use serde_json::json;
use solana_rpc_client::{
    http_sender::HttpSender,
    nonblocking::rpc_client::RpcClient,
    rpc_client::RpcClientConfig,
    rpc_sender::{RpcSender, RpcTransportStats},
};
use solana_rpc_client_api::{
    client_error::{Error, ErrorKind, Result},
    request::{RpcError, RpcRequest, RpcResponseErrorData},
    response::RpcSimulateTransactionResult,
};
use solana_transaction_error::TransactionError;
use std::sync::atomic::{AtomicU32, Ordering};
use support::*;

const BOND: u64 = 2_000_000;
const BACKING: u64 = 3_000_000;

/// The validator behind a front that refuses the first `lagging` sends as a node behind it would.
struct Lagging {
    inner: HttpSender,
    lagging: AtomicU32,
}

#[async_trait]
impl RpcSender for Lagging {
    async fn send(
        &self,
        request: RpcRequest,
        params: serde_json::Value,
    ) -> Result<serde_json::Value> {
        if request == RpcRequest::SendTransaction
            && self
                .lagging
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                    left.checked_sub(1)
                })
                .is_ok()
        {
            return Err(Error::from(ErrorKind::RpcError(
                RpcError::RpcResponseError {
                    code: -32002,
                    message: "Transaction simulation failed: Blockhash not found".to_owned(),
                    data: RpcResponseErrorData::SendTransactionPreflightFailure(
                        RpcSimulateTransactionResult {
                            err: Some(TransactionError::BlockhashNotFound.into()),
                            logs: None,
                            accounts: None,
                            units_consumed: None,
                            loaded_accounts_data_size: None,
                            return_data: None,
                            inner_instructions: None,
                            replacement_blockhash: None,
                            fee: None,
                            pre_balances: None,
                            post_balances: None,
                            pre_token_balances: None,
                            post_token_balances: None,
                            loaded_addresses: None,
                        },
                    ),
                },
            )));
        }
        self.inner.send(request, params).await
    }

    fn get_transport_stats(&self) -> RpcTransportStats {
        self.inner.get_transport_stats()
    }

    fn url(&self) -> String {
        self.inner.url()
    }
}

async fn onboard_through(lagging: u32) -> (StatusCode, serde_json::Value) {
    let sender = Lagging {
        inner: HttpSender::new(cluster().url.clone()),
        lagging: AtomicU32::new(lagging),
    };
    let rpc = RpcClient::new_sender(
        sender,
        RpcClientConfig::with_commitment(solana_commitment_config::CommitmentConfig::confirmed()),
    );
    let sponsor = Sponsor::on(
        rpc,
        funded(1_000_000_000).await,
        SponsorLimits::new(caps()),
        SettlementLimits::new(float_caps()),
        settings(),
        ClientAddress::Peer,
        rents().await,
        1_000,
    );
    let wallet = wallet(BOND + BACKING).await;
    let device = Device::random();
    let until = chain_now().await + 600;
    let prepared = sponsor
        .prepare(
            "/v1/onboard",
            &device.onboard_request(&wallet, BOND, BACKING, until),
        )
        .await;
    sponsor
        .submit(
            "/v1/onboard/submit",
            &device.key(),
            &prepared.signed_by(&wallet.keypair),
        )
        .await
}

#[tokio::test]
async fn a_send_retries_while_the_preflight_node_lags() {
    let (status, body) = onboard_through(2).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn a_send_that_still_lags_asks_to_try_again_and_says_nothing_was_sent() {
    let (status, body) = onboard_through(u32::MAX).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["retry"], json!(true));
}
