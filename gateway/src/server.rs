use crate::{
    hpke::{HpkeKeys, PublishedKey},
    limits::{Limits, Prefix, Refusal},
    registration::{self, Pending},
};
use axum::{
    Extension, Json, RequestExt, Router,
    error_handling::HandleErrorLayer,
    extract::{ConnectInfo, DefaultBodyLimit, Request, State},
    http::{HeaderName, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Serialize;
use solana_keypair::Keypair;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use std::{
    collections::HashMap,
    fs, io,
    net::{IpAddr, SocketAddr},
    os::unix::fs::PermissionsExt,
    path::Path,
    sync::{Arc, Mutex},
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
    /// The genesis hash of the cluster the program is built for: device bindings sign for it.
    pub genesis_hash: [u8; 32],
    /// The highest compute unit price the gateway pays, in micro-lamports.
    pub max_priority_fee: u64,
    /// What a registration costs the fee payer before its priority fee: the device account's
    /// rent and three signatures, in lamports.
    pub registration_cost: u64,
    /// How long a prepared registration waits for the wallet's signature.
    pub pending_ttl: Duration,
}

/// Everything the endpoints share.
pub struct Gateway {
    pub rpc: RpcClient,
    pub fee_payer: Keypair,
    pub settings: Settings,
    pub limits: Arc<Limits>,
    pub hpke: HpkeKeys,
    /// Prepared registrations by device key.
    pub(crate) pending: Mutex<HashMap<[u8; 33], Pending>>,
}

impl Gateway {
    pub fn new(
        rpc: RpcClient,
        fee_payer: Keypair,
        settings: Settings,
        limits: Limits,
        hpke: HpkeKeys,
    ) -> Self {
        Self {
            rpc,
            fee_payer,
            settings,
            limits: Arc::new(limits),
            hpke,
            pending: Mutex::default(),
        }
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

pub fn router(gateway: Gateway, client: ClientAddress) -> Router {
    let state = Arc::new(gateway);
    let limited = Router::new()
        .route("/v1/hpke-config", get(hpke_config))
        .route(
            "/v1/registrations/sponsorship",
            get(registration::sponsorship),
        )
        .route("/v1/registrations", post(registration::prepare))
        .route("/v1/registrations/submit", post(registration::submit))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
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
        .route("/health", get(|| async { "ok" }))
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
    match state.limits.request(Prefix::from(ip)) {
        Ok(()) => next.run(request).await,
        Err(refusal) => Error::Refused(refusal).into_response(),
    }
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
    Gone,
    Refused(Refusal),
    /// Solana refused the transaction in its preflight simulation: nothing was sent.
    Rejected,
    /// The fee payer cannot pay for the registrations being prepared.
    Unfunded,
    /// The gateway serves `IN_FLIGHT` requests already.
    Busy,
    /// Solana could not be read, or did not answer whether it took a transaction.
    Upstream,
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Error::BadRequest(message) => (StatusCode::BAD_REQUEST, message.to_owned()),
            Error::Conflict(message) => (StatusCode::CONFLICT, message.to_owned()),
            Error::Gone => (
                StatusCode::GONE,
                "no prepared registration for this key".to_owned(),
            ),
            Error::Refused(Refusal::RateLimited) => (
                StatusCode::TOO_MANY_REQUESTS,
                "too many requests".to_owned(),
            ),
            Error::Refused(Refusal::PrefixBusy) => (
                StatusCode::TOO_MANY_REQUESTS,
                "this network is preparing too many registrations".to_owned(),
            ),
            Error::Refused(Refusal::PrefixSpent) => (
                StatusCode::TOO_MANY_REQUESTS,
                "sponsored registrations from this network are used up for today".to_owned(),
            ),
            Error::Busy => (
                StatusCode::SERVICE_UNAVAILABLE,
                "the gateway is busy".to_owned(),
            ),
            Error::Refused(Refusal::BudgetSpent) | Error::Unfunded => (
                StatusCode::SERVICE_UNAVAILABLE,
                "sponsorship is unavailable".to_owned(),
            ),
            Error::Rejected => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "Solana refused the registration in its preflight; nothing was sent".to_owned(),
            ),
            Error::Upstream => (StatusCode::BAD_GATEWAY, "Solana is unreachable".to_owned()),
        };
        (status, Json(serde_json::json!({ "error": message }))).into_response()
    }
}
