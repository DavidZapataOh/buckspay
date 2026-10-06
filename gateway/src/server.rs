use crate::{
    chain::Rents,
    claims,
    float::SettlementLimits,
    hpke::{HpkeKeys, PublishedKey},
    jobs::Jobs,
    limits::{Prefix, RateLimited, RequestLimits},
    onboard, operations,
    settlements::{self, Problem},
    sponsor::{FeeMode, Refusal, SponsorLimits},
    sponsored::{self, Pending},
};
use axum::{
    Extension, Json, RequestExt, Router,
    error_handling::HandleErrorLayer,
    extract::{ConnectInfo, DefaultBodyLimit, Request, State},
    http::{HeaderName, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, get, post},
};
use buckspay_client::Program;
use buckspay_protocol::lock::Windows;
use serde::Serialize;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use std::{
    collections::HashMap,
    fs, io,
    net::{IpAddr, SocketAddr},
    os::unix::fs::PermissionsExt,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::net::UnixListener;
use tower::{BoxError, ServiceBuilder, limit::GlobalConcurrencyLimitLayer};
use tower_http::timeout::RequestBodyDeadlineLayer;

/// Requests are a few hundred bytes; anything larger is refused before it is read.
pub const BODY_LIMIT: usize = 4096;
/// The time a request has to deliver its whole body, however it trickles in: a slow client holds
/// a connection no longer.
pub const BODY_DEADLINE: Duration = Duration::from_secs(10);
/// Requests the endpoints serve at once; more are refused at once (`503`) instead of waiting.
pub const IN_FLIGHT: usize = 256;
/// The time one RPC request to Solana may take.
pub const RPC_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Settings {
    /// The deployment of the program being sponsored, and its windows.
    pub program: Program,
    pub windows: Windows,
    /// The genesis hash of the cluster the program is built for: device bindings sign for it.
    pub genesis_hash: [u8; 32],
    /// The one mint locks are sponsored for.
    pub mint: Pubkey,
    /// The highest compute unit price the gateway pays, in micro-lamports.
    pub max_priority_fee: u64,
    /// How long a prepared transaction waits for the wallet's signature.
    pub pending_ttl: Duration,
    /// How long a sent transaction is waited for before its outcome is called unknown.
    pub confirm_timeout: Duration,
    /// Sponsored locks are at most this many days long.
    pub max_lock_days: u32,
    /// The operator's setting for the onboarding fee, which the escalation can raise but not lower.
    pub fee_mode: FeeMode,
    /// A token account of the mint owned by the fee payer, which receives the fee.
    pub fee_token: Option<Pubkey>,
    /// Micro-units of the mint per SOL, for pricing the fee.
    pub sol_price_micro_usdc: Option<u64>,
    /// Other addresses the gateway signs for: no endpoint accepts them as a wallet.
    pub held_keys: Vec<Pubkey>,
    /// Lamports of rent the gateway may have out in claim accounts at once.
    pub claim_float_cap: u64,
}

/// Everything the endpoints share.
pub struct Gateway {
    pub rpc: RpcClient,
    pub fee_payer: Keypair,
    pub settings: Settings,
    pub requests: RequestLimits,
    pub sponsor: Arc<SponsorLimits>,
    /// What the gateway lends as the rent of the settlement records it pays for.
    pub settlements: Arc<SettlementLimits>,
    /// The settlements that take several transactions, until each ends.
    pub jobs: Jobs,
    pub hpke: HpkeKeys,
    /// What the program's accounts cost, as last read from the cluster.
    pub(crate) rents: Mutex<Rents>,
    /// Prepared transactions by device key.
    pub(crate) pending: Mutex<HashMap<[u8; 33], Pending>>,
    /// The device keys of the rotation requests this process sponsored, by rotation account: the
    /// account does not hold its key, and the janitor needs it to apply the rotation.
    pub(crate) rotation_keys: Mutex<HashMap<Pubkey, [u8; 33]>>,
    /// Locks the janitor found due whose wallet has no token account to release to.
    pub(crate) stuck: AtomicU64,
    /// Held while a claim is filed, so that the cap on what is fronted for claims holds exactly.
    pub(crate) claiming: tokio::sync::Mutex<()>,
}

/// What bounds the gateway: requests per network, what it lends to onboard, and what it lends as
/// the rent of settlement records.
pub struct Limits {
    pub requests: RequestLimits,
    pub sponsor: Arc<SponsorLimits>,
    pub settlements: Arc<SettlementLimits>,
}

impl Gateway {
    /// Keeps the jobs in `jobs`, which survives a restart, in place of the ones in memory.
    pub fn with_jobs(mut self, jobs: Jobs) -> Self {
        self.jobs = jobs;
        self
    }

    pub fn new(
        rpc: RpcClient,
        fee_payer: Keypair,
        settings: Settings,
        rents: Rents,
        limits: Limits,
        hpke: HpkeKeys,
    ) -> Self {
        Self {
            rpc,
            fee_payer,
            settings,
            requests: limits.requests,
            sponsor: limits.sponsor,
            settlements: limits.settlements,
            jobs: Jobs::default(),
            hpke,
            rents: Mutex::new(rents),
            pending: Mutex::default(),
            rotation_keys: Mutex::default(),
            stuck: AtomicU64::new(0),
            claiming: tokio::sync::Mutex::new(()),
        }
    }

    pub fn rents(&self) -> Rents {
        *self.rents.lock().unwrap()
    }

    /// Whether `address` is one the gateway signs for.
    pub(crate) fn is_ours(&self, address: &Pubkey) -> bool {
        use solana_signer::Signer;
        *address == self.fee_payer.pubkey() || self.settings.held_keys.contains(address)
    }
}

/// Where a request's client address comes from.
#[derive(Clone)]
pub enum ClientAddress {
    /// The TCP connection's peer: development, without a proxy.
    Peer,
    /// A header the reverse proxy sets from its own peer, overwriting whatever the client sent:
    /// trusted only because nothing but the proxy can reach the gateway's Unix socket.
    Header(HeaderName),
}

/// The address a request came from, for limits only: it is never logged or stored.
#[derive(Clone, Copy)]
pub struct Client(pub IpAddr);

pub fn router(state: Arc<Gateway>, client: ClientAddress) -> Router {
    let limited = Router::new()
        .route("/v1/hpke-config", get(hpke_config))
        .route("/v1/onboarding/quote", get(onboard::quote))
        .route("/v1/onboard", post(onboard::prepare))
        .route("/v1/onboard/submit", post(sponsored::submit))
        .route("/v1/locks", post(operations::lock))
        .route("/v1/locks/submit", post(sponsored::submit))
        .route("/v1/withdrawals", post(operations::withdrawal))
        .route("/v1/withdrawals/submit", post(sponsored::submit))
        .route("/v1/rotations/request", post(operations::rotation_request))
        .route("/v1/rotations/cancel", post(operations::rotation_cancel))
        .route("/v1/rotations/submit", post(sponsored::submit))
        .route("/v1/rotations/pending", get(operations::rotation_pending))
        .route("/v1/registrations", any(retired))
        .route("/v1/registrations/sponsorship", any(retired))
        .route("/v1/registrations/submit", any(retired))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .merge(
            Router::new()
                .route("/v1/settlements", post(settlements::settle))
                .route("/v1/settlements/quote", get(settlements::quote))
                .route("/v1/reclaims", post(settlements::reclaim))
                .route("/v1/fraud/claim", post(claims::claim))
                .layer(DefaultBodyLimit::max(settlements::BODY_LIMIT)),
        )
        .layer(RequestBodyDeadlineLayer::new(BODY_DEADLINE))
        .layer(
            ServiceBuilder::new()
                .layer(HandleErrorLayer::new(|_: BoxError| async { Error::Busy }))
                .load_shed()
                .layer(GlobalConcurrencyLimitLayer::new(IN_FLIGHT)),
        )
        .layer(middleware::from_fn_with_state(state.clone(), rate_limit))
        .layer(middleware::from_fn_with_state(client, client_address));
    Router::new()
        .route("/health", get(health))
        .merge(limited)
        .with_state(state)
}

/// Listens on a Unix socket at `path` that only its owner and group (the reverse proxy's) can open.
pub fn bind_unix(path: &Path) -> io::Result<UnixListener> {
    let _ = fs::remove_file(path);
    let listener = UnixListener::bind(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o660))?;
    Ok(listener)
}

async fn client_address(
    State(source): State<ClientAddress>,
    mut request: Request,
    next: Next,
) -> Response {
    let ip = match &source {
        ClientAddress::Peer => request
            .extract_parts::<ConnectInfo<SocketAddr>>()
            .await
            .ok()
            .map(|ConnectInfo(peer)| peer.ip()),
        ClientAddress::Header(name) => request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok()),
    };
    match ip {
        Some(ip) => {
            request.extensions_mut().insert(Client(ip));
            next.run(request).await
        }
        None => Error::BadRequest("no client address").into_response(),
    }
}

async fn rate_limit(
    State(state): State<Arc<Gateway>>,
    Extension(Client(ip)): Extension<Client>,
    request: Request,
    next: Next,
) -> Response {
    match state.requests.check(Prefix::from(ip)) {
        Ok(()) => next.run(request).await,
        Err(RateLimited) => Error::RateLimited.into_response(),
    }
}

/// Whether the gateway is up, and what the janitor and the caps report: locks it cannot release
/// because their wallet has no token account, locks and rotations it has lent rent for, and sends
/// whose outcome Solana never reported.
async fn health(State(state): State<Arc<Gateway>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "stuck": state.stuck.load(Ordering::Relaxed),
        "openLocks": state.sponsor.open_locks(),
        "unknownSends": state.sponsor.unknown_sends(),
    }))
}

/// Sponsored registration without funds is exactly the state that no longer exists: registration
/// and the first lock are one transaction.
async fn retired() -> Error {
    Error::Retired
}

#[derive(Serialize)]
struct HpkeConfig {
    keys: Vec<PublishedKey>,
}

/// The gateway's HPKE keys, current first. Apps seal only to a key they pinned.
async fn hpke_config(State(state): State<Arc<Gateway>>) -> Json<HpkeConfig> {
    Json(HpkeConfig {
        keys: state.hpke.published(),
    })
}

#[derive(Debug, PartialEq)]
pub enum Error {
    BadRequest(&'static str),
    Conflict(&'static str),
    /// There is no prepared transaction for this key.
    Gone,
    /// The endpoint was removed.
    Retired,
    RateLimited,
    /// A cap or the minimum funding refuses the sponsorship.
    Refused(Refusal),
    /// Solana refused the transaction in its preflight simulation: nothing was sent.
    Rejected,
    /// The transaction landed and failed: the sponsor paid its fee.
    Failed,
    /// A settlement or a reclaim the gateway does not sponsor, and why.
    Settlement(Problem),
    /// The fee payer cannot pay for what is being prepared.
    Unfunded,
    /// The gateway serves `IN_FLIGHT` requests already.
    Busy,
    /// Solana's node did not know the blockhash in its preflight: nothing was sent, try again.
    Retry,
    /// Solana could not be read, or did not answer whether it took a transaction.
    Upstream,
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let json = |status, message: &str| (status, Json(serde_json::json!({ "error": message })));
        match self {
            Error::BadRequest(message) => json(StatusCode::BAD_REQUEST, message).into_response(),
            Error::Conflict(message) => json(StatusCode::CONFLICT, message).into_response(),
            Error::Gone => {
                json(StatusCode::GONE, "no prepared transaction for this key").into_response()
            }
            Error::Retired => json(
                StatusCode::GONE,
                "registration without funds was retired: use /v1/onboard",
            )
            .into_response(),
            Error::RateLimited => {
                json(StatusCode::TOO_MANY_REQUESTS, "too many requests").into_response()
            }
            Error::Refused(Refusal::PrefixBusy) => json(
                StatusCode::TOO_MANY_REQUESTS,
                "this network is preparing too many transactions",
            )
            .into_response(),
            Error::Refused(Refusal::PrefixSpentToday) => json(
                StatusCode::TOO_MANY_REQUESTS,
                "sponsored transactions from this network are used up for today",
            )
            .into_response(),
            Error::Refused(Refusal::PrefixSpentThisMonth) => json(
                StatusCode::TOO_MANY_REQUESTS,
                "sponsored transactions from this network are used up for this month",
            )
            .into_response(),
            Error::Refused(Refusal::BelowMinimum(minimum)) => (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": "the funding is below the minimum sponsored funding",
                    "minFunding": minimum.to_string(),
                })),
            )
                .into_response(),
            Error::Refused(
                Refusal::DailyCap | Refusal::CacBudget | Refusal::OpenRentCap | Refusal::Unwritable,
            )
            | Error::Unfunded => json(
                StatusCode::SERVICE_UNAVAILABLE,
                "sponsorship is unavailable",
            )
            .into_response(),
            Error::Settlement(problem) => problem.into_response(),
            Error::Busy => {
                json(StatusCode::SERVICE_UNAVAILABLE, "the gateway is busy").into_response()
            }
            Error::Rejected => json(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Solana refused the transaction in its preflight; nothing was sent",
            )
            .into_response(),
            Error::Retry => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({
                    "error": "Solana did not know the transaction's blockhash yet; nothing was sent, try again",
                    "retry": true,
                })),
            )
                .into_response(),
            Error::Failed => {
                json(StatusCode::CONFLICT, "the transaction was sent and failed").into_response()
            }
            Error::Upstream => {
                json(StatusCode::BAD_GATEWAY, "Solana is unreachable").into_response()
            }
        }
    }
}
