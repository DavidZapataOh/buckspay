use buckspay_client::{accounts::Device, programs::BUCKSPAY_ID};
use buckspay_gateway::{
    config::{Config, Listen},
    limits::Limits,
    registration::PENDING_TTL,
    server::{ClientAddress, Gateway, RPC_TIMEOUT, Settings, bind_unix, router},
};
use solana_commitment_config::CommitmentConfig;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_signer::Signer;
use std::net::SocketAddr;
use tokio::signal::unix::{SignalKind, signal};
use tracing::info;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt().with_ansi(false).init();
    let config = Config::from_env()?;
    let rpc = RpcClient::new_with_timeout_and_commitment(
        config.rpc_url.clone(),
        RPC_TIMEOUT,
        CommitmentConfig::confirmed(),
    );

    // Refuse to sponsor on another cluster or for a program that is not there. The RPC's errors
    // carry its URL, which may hold an API key, so they are not shown.
    let unreachable = |_| "RPC_URL is unreachable";
    let genesis = rpc.get_genesis_hash().await.map_err(unreachable)?;
    config.cluster.check_rpc_genesis_hash(genesis.to_bytes())?;
    let program = rpc.get_account(&BUCKSPAY_ID).await.map_err(unreachable)?;
    if !program.executable {
        return Err(format!("{BUCKSPAY_ID} is not a deployed program").into());
    }
    let rent = rpc
        .get_minimum_balance_for_rent_exemption(Device::LEN)
        .await
        .map_err(unreachable)?;

    let limits = Limits::open(
        config.caps,
        &config.state_directory.join("sponsorships.json"),
    )?;
    let settings = Settings {
        genesis_hash: config.cluster.binding_genesis_hash(),
        max_priority_fee: config.max_priority_fee,
        registration_cost: rent + 3 * 5_000,
        pending_ttl: PENDING_TTL,
    };
    info!(
        cluster = ?config.cluster,
        fee_payer = %config.fee_payer.pubkey(),
        "starting"
    );
    let gateway = Gateway::new(rpc, config.fee_payer, settings, limits, config.hpke);
    let shutdown = async {
        signal(SignalKind::terminate())
            .expect("SIGTERM handler")
            .recv()
            .await;
    };
    match config.listen {
        Listen::Tcp(address) => {
            let listener = tokio::net::TcpListener::bind(address).await?;
            info!(%address, "listening");
            axum::serve(
                listener,
                router(gateway, ClientAddress::Peer)
                    .into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(shutdown)
            .await?;
        }
        Listen::Unix(path) => {
            let listener = bind_unix(&path)?;
            info!(path = %path.display(), "listening");
            axum::serve(
                listener,
                router(gateway, ClientAddress::Header("x-real-ip".parse()?)),
            )
            .with_graceful_shutdown(shutdown)
            .await?;
        }
    }
    Ok(())
}
