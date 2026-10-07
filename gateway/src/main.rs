use buckspay_client::{Program, accounts};
use buckspay_gateway::{
    chain::{self, Rents},
    claims,
    config::{Config, Listen},
    float::{Caps as FloatCaps, SettlementLimits},
    janitor,
    jobs::Jobs,
    limits::RequestLimits,
    relay::{self, Relay},
    server::{ClientAddress, Gateway, Limits, RPC_TIMEOUT, Settings, bind_unix, router},
    settlements,
    sponsor::SponsorLimits,
    sponsored::{CONFIRM_TIMEOUT, PENDING_TTL},
    zk::Zk,
};
use buckspay_protocol::lock::Windows;
use solana_commitment_config::CommitmentConfig;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_signer::Signer;
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::signal::unix::{SignalKind, signal};
use tracing::info;

/// How often the janitor returns the rents the gateway lent.
const JANITOR_INTERVAL: Duration = Duration::from_secs(60 * 60);

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt().with_ansi(false).init();
    let config = Config::from_env()?;
    let rpc = RpcClient::new_with_timeout_and_commitment(
        config.rpc_url.clone(),
        RPC_TIMEOUT,
        CommitmentConfig::confirmed(),
    );

    // Refuse to sponsor on another cluster, for a program that is not there or for a mint that is
    // not a plain 6-decimal one. The RPC's errors carry its URL, which may hold an API key, so they
    // are not shown.
    let unreachable = |_| "RPC_URL is unreachable";
    let genesis = rpc.get_genesis_hash().await.map_err(unreachable)?;
    config.cluster.check_rpc_genesis_hash(genesis.to_bytes())?;
    let program = rpc
        .get_account(&config.program_id)
        .await
        .map_err(unreachable)?;
    if !program.executable {
        return Err(format!("{} is not a deployed program", config.program_id).into());
    }
    let mint = rpc.get_account(&config.mint).await.map_err(unreachable)?;
    if !(mint.owner == chain::TOKEN_PROGRAM || mint.owner == chain::TOKEN_2022_PROGRAM)
        || chain::mint_decimals(&mint.data) != Some(6)
    {
        return Err("MINT is not a token mint with 6 decimals".into());
    }
    let rents = Rents {
        device: rpc
            .get_minimum_balance_for_rent_exemption(accounts::Device::LEN)
            .await
            .map_err(unreachable)?,
        rotation: rpc
            .get_minimum_balance_for_rent_exemption(accounts::Rotation::LEN)
            .await
            .map_err(unreachable)?,
        lock: rpc
            .get_minimum_balance_for_rent_exemption(accounts::Lock::LEN)
            .await
            .map_err(unreachable)?,
        ledger: rpc
            .get_minimum_balance_for_rent_exemption(accounts::Ledger::LEN)
            .await
            .map_err(unreachable)?,
        escrow: rpc
            .get_minimum_balance_for_rent_exemption(165)
            .await
            .map_err(unreachable)?,
        record: rpc
            .get_minimum_balance_for_rent_exemption(settlements::RECORD_LEN as usize)
            .await
            .map_err(unreachable)?,
        claim: rpc
            .get_minimum_balance_for_rent_exemption(claims::CLAIM_LEN as usize)
            .await
            .map_err(unreachable)?,
    };

    // The app accepts a fee only into the fee payer's associated token account of the mint.
    if let Some(fee_token) = config.fee_token
        && fee_token
            != chain::associated_token_address(
                &config.fee_payer.pubkey(),
                &config.mint,
                &mint.owner,
            )
    {
        return Err(
            "FEE_TOKEN_ACCOUNT is not the fee payer's associated token account of MINT".into(),
        );
    }

    let sponsor = SponsorLimits::open(
        config.caps.clone(),
        &config.state_directory.join("sponsorships.json"),
    )?;
    let windows = if config.program_id.to_string() == buckspay_protocol::profile::SHORT_PROGRAM_ID {
        Windows::SHORT
    } else {
        Windows::PRODUCTION
    };
    info!(
        min_bond = config.settlement_min_bond,
        "settlement minimum bond"
    );
    let settlements = SettlementLimits::open(
        FloatCaps {
            float_cap: config.settlement_float_cap,
            bond_per_record: config.settlement_bond_per_record,
            min_bond: config.settlement_min_bond,
            relay_per_day: config.relay_daily_cap,
            ..FloatCaps::pilot(windows.record_ttl())
        },
        &config.state_directory.join("settlements.json"),
    )?;
    let settings = Settings {
        program: Program::new(config.program_id),
        windows,
        genesis_hash: config.cluster.binding_genesis_hash(),
        mint: config.mint,
        max_priority_fee: config.max_priority_fee,
        pending_ttl: PENDING_TTL,
        confirm_timeout: CONFIRM_TIMEOUT,
        max_lock_days: config.max_lock_days,
        claim_float_cap: config.claim_float_cap,
        fee_mode: config.fee_mode,
        fee_token: config.fee_token,
        sol_price_micro_usdc: config.sol_price_micro_usdc,
        held_keys: config.held_keys,
    };
    info!(
        cluster = ?config.cluster,
        fee_payer = %config.fee_payer.pubkey(),
        "starting"
    );
    let mut zk = Zk::new(config.zk_verifications_per_minute);
    if let Some(url) = config.zk_keys_url {
        zk = zk.with_keys_url(url);
    }
    let jobs = Jobs::open(&config.state_directory.join("jobs.json"))?;
    let gateway = Arc::new(
        Gateway::new(
            rpc,
            config.fee_payer,
            settings,
            rents,
            Limits {
                requests: RequestLimits::new(config.requests_per_minute),
                sponsor,
                settlements,
            },
            config.hpke,
        )
        .with_jobs(jobs)
        .with_relay(Relay::with_delay(config.relay_delay_max_secs))
        .with_zk(zk),
    );
    relay::resume_pending(&gateway);
    janitor::spawn(Arc::clone(&gateway), JANITOR_INTERVAL);
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
