use buckspay_client::Program;
use buckspay_gateway::{
    attester::{
        limits::{Limits, Settings},
        plan::{Issuer, Policy},
        reader::Providers,
        server::{Service, router},
    },
    config::{Cluster, check_key_file},
    server::{ClientAddress, bind_unix},
};
use buckspay_protocol::{
    hash::{domain, purpose},
    profile::{PRODUCTION_DEVNET_PROGRAM_ID, SHORT_PROGRAM_ID},
};
use solana_pubkey::Pubkey;
use std::{env, fs, net::SocketAddr, path::Path, str::FromStr, sync::Arc};
use tokio::signal::unix::{SignalKind, signal};
use tracing::info;

fn required(name: &str) -> Result<String, String> {
    env::var(name).map_err(|_| format!("{name} is required"))
}

/// The 32-byte signing seed, in a file only its owner (or the unit's systemd credential) can read.
fn read_seed(path: &Path) -> Result<[u8; 32], String> {
    check_key_file(path)?;
    fs::read(path)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| "ATTESTER_KEY_FILE must hold exactly 32 bytes".into())
}

fn hex32(name: &str) -> Result<[u8; 32], String> {
    hex::decode(required(name)?)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| format!("{name} must be 64 hex characters"))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt().with_ansi(false).init();
    let cluster = Cluster::parse(env::var("BUCKSPAY_CLUSTER").ok().as_deref(), true)?;
    let program_id = Pubkey::from_str(&match env::var("BUCKSPAY_PROFILE").as_deref() {
        Ok("short") => SHORT_PROGRAM_ID.to_owned(),
        _ => PRODUCTION_DEVNET_PROGRAM_ID.to_owned(),
    })?;
    let providers = Providers::new(
        Program::new(program_id),
        [&required("RPC_URL_A")?, &required("RPC_URL_B")?],
    )?;
    let mint = Pubkey::from_str(&required("MINT")?)?;
    let seed = read_seed(Path::new(&required("ATTESTER_KEY_FILE")?))?;
    let policy = Policy {
        attester: required("ATTESTER_ID")?.parse()?,
        mint: mint.to_bytes(),
        lifetimes: [86_400, 255_600],
        quantum: 3_600,
    };
    let genesis = cluster.binding_genesis_hash();
    let issuer = Issuer::new(
        seed,
        domain(purpose::TICKET, &genesis, &program_id.to_bytes()),
    );
    let state = std::path::PathBuf::from(required("STATE_DIRECTORY")?);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs() as u32;
    let limits = Limits::open(Settings::pilot(), &state.join("attester-counts.json"), now)?;
    let service = Arc::new(Service::new(
        providers,
        issuer,
        policy,
        hex32("ATTESTER_AUTHORITY")?,
        limits,
        env::var("REVOCATIONS_FILE").ok().map(Into::into),
    ));
    info!(attester = policy.attester, "starting");
    let shutdown = async {
        signal(SignalKind::terminate())
            .expect("SIGTERM handler")
            .recv()
            .await;
    };
    match env::var("LISTEN_UNIX").ok() {
        Some(path) => {
            let listener = bind_unix(Path::new(&path))?;
            axum::serve(
                listener,
                router(
                    Arc::clone(&service),
                    ClientAddress::Header("x-real-ip".parse()?),
                ),
            )
            .with_graceful_shutdown(shutdown)
            .await?;
        }
        None => {
            let address: SocketAddr = env::var("LISTEN")
                .unwrap_or_else(|_| "127.0.0.1:8788".into())
                .parse()?;
            let listener = tokio::net::TcpListener::bind(address).await?;
            axum::serve(
                listener,
                router(Arc::clone(&service), ClientAddress::Peer)
                    .into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(shutdown)
            .await?;
        }
    }
    service.limits.persist()?;
    Ok(())
}
