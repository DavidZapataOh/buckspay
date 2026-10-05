//! The attester's HTTP side. Checks run cheapest first and nothing before the chain read costs an
//! RPC call: network limits, body cap, JSON, lifetime, key limits, the read, the clock, the plan.
use super::{
    limits::{Denied, Limits},
    plan::{ChainView, Issuer, Policy, Refusal, plan},
    reader::{ChainReader, LockId, ReadError},
};
use crate::{
    limits::Prefix,
    server::{Client, ClientAddress},
};
use axum::{
    Extension, Json, Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderName, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use buckspay_protocol::attest::Revocation;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::Semaphore;
use tower_http::timeout::TimeoutLayer;

pub const BODY_LIMIT: usize = 1024;
pub const MAX_LOCKS: usize = 8;
/// Requests in flight at once; a request over it is told to come back.
pub const IN_FLIGHT: usize = 256;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// The most the service's clock may differ from the finalized block's before it refuses to sign.
pub const CLOCK_TOLERANCE: i64 = 30;
const RETRY_AFTER: u32 = 30;

pub struct Service<R> {
    pub reader: R,
    pub issuer: Issuer,
    pub policy: Policy,
    pub authority: [u8; 32],
    pub limits: Limits,
    pub clock: Box<dyn Fn() -> u32 + Send + Sync>,
    /// A file of hex revocation notices the authority wrote offline, one per line.
    pub revocations: Option<PathBuf>,
    pub in_flight: Semaphore,
}

impl<R> Service<R> {
    pub fn new(
        reader: R,
        issuer: Issuer,
        policy: Policy,
        authority: [u8; 32],
        limits: Limits,
        revocations: Option<PathBuf>,
    ) -> Self {
        Self {
            reader,
            issuer,
            policy,
            authority,
            limits,
            clock: Box::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| u32::try_from(d.as_secs()).unwrap_or(u32::MAX))
            }),
            revocations,
            in_flight: Semaphore::new(IN_FLIGHT),
        }
    }
}

enum Error {
    BadRequest(&'static str),
    Limited,
    Unavailable,
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        match self {
            Self::BadRequest(reason) => {
                (StatusCode::BAD_REQUEST, Json(json!({ "error": reason }))).into_response()
            }
            Self::Limited => (
                StatusCode::TOO_MANY_REQUESTS,
                [(header::RETRY_AFTER, HeaderValue::from(60))],
                Json(json!({ "error": "rate_limited" })),
            )
                .into_response(),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "unavailable", "retryAfter": RETRY_AFTER })),
            )
                .into_response(),
        }
    }
}

pub fn router<R: ChainReader>(service: Arc<Service<R>>, client: ClientAddress) -> Router {
    Router::new()
        .route("/v1/tickets", post(tickets::<R>))
        .route("/v1/attester", get(attester::<R>))
        .route("/v1/revocations", get(revocations::<R>))
        .layer(middleware::from_fn_with_state(client, client_address))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::SERVICE_UNAVAILABLE,
            REQUEST_TIMEOUT,
        ))
        .with_state(service)
}

async fn client_address(
    State(source): State<ClientAddress>,
    mut request: Request,
    next: Next,
) -> Response {
    use axum::extract::{ConnectInfo, FromRequestParts};
    let (mut parts, body) = request.into_parts();
    let ip = match &source {
        ClientAddress::Peer => ConnectInfo::<SocketAddr>::from_request_parts(&mut parts, &())
            .await
            .ok()
            .map(|ConnectInfo(peer)| peer.ip()),
        ClientAddress::Header(name) => header_ip(&parts, name),
    };
    request = Request::from_parts(parts, body);
    match ip {
        Some(ip) => {
            request.extensions_mut().insert(Client(ip));
            next.run(request).await
        }
        None => Error::BadRequest("no client address").into_response(),
    }
}

fn header_ip(parts: &axum::http::request::Parts, name: &HeaderName) -> Option<std::net::IpAddr> {
    parts.headers.get(name)?.to_str().ok()?.parse().ok()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Ask {
    locks: Vec<AskedLock>,
    lifetime: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AskedLock {
    key: String,
    lock_seq: u32,
}

fn parse_key(text: &str) -> Result<[u8; 33], Error> {
    let bytes: [u8; 33] = hex::decode(text)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(Error::BadRequest("key"))?;
    if bytes[0] != 2 && bytes[0] != 3 {
        return Err(Error::BadRequest("key"));
    }
    Ok(bytes)
}

async fn tickets<R: ChainReader>(
    State(service): State<Arc<Service<R>>>,
    Extension(Client(ip)): Extension<Client>,
    body: Body,
) -> Result<Json<Value>, Error> {
    let _permit = service
        .in_flight
        .try_acquire()
        .map_err(|_| Error::Unavailable)?;
    let now = (service.clock)();
    service
        .limits
        .admit_network(Prefix::from(ip), now)
        .map_err(|Denied| Error::Limited)?;
    let bytes = to_bytes(body, BODY_LIMIT)
        .await
        .map_err(|_| Error::BadRequest("body"))?;
    let ask: Ask = serde_json::from_slice(&bytes).map_err(|_| Error::BadRequest("json"))?;
    if ask.locks.is_empty() || ask.locks.len() > MAX_LOCKS {
        return Err(Error::BadRequest("locks"));
    }
    if !service.policy.lifetimes.contains(&ask.lifetime) {
        return Err(Error::BadRequest("lifetime"));
    }
    let mut asked = Vec::with_capacity(ask.locks.len());
    for lock in &ask.locks {
        if lock.lock_seq == u32::MAX {
            return Err(Error::BadRequest("lockSeq"));
        }
        asked.push(LockId {
            device: parse_key(&lock.key)?,
            lock_seq: lock.lock_seq,
        });
    }
    let devices: Vec<[u8; 33]> = asked.iter().map(|lock| lock.device).collect();
    service
        .limits
        .admit_keys(&devices, now)
        .map_err(|Denied| Error::Limited)?;

    let snapshot = service
        .reader
        .read(&asked)
        .await
        .map_err(|error| match error {
            ReadError::Unavailable | ReadError::Disagree => Error::Unavailable,
        })?;
    if snapshot.views.len() != asked.len()
        || (i64::from(now) - snapshot.unix).abs() > CLOCK_TOLERANCE
    {
        return Err(Error::Unavailable);
    }
    let results: Vec<Value> = asked
        .iter()
        .zip(&snapshot.views)
        .map(|(lock, view)| answer(&service, lock, view, now, ask.lifetime))
        .collect();
    Ok(Json(
        json!({ "attester": service.policy.attester, "now": now, "results": results }),
    ))
}

fn answer<R>(
    service: &Service<R>,
    lock: &LockId,
    view: &ChainView,
    now: u32,
    lifetime: u32,
) -> Value {
    let key = hex::encode(lock.device);
    match plan(
        &service.policy,
        lock.device,
        lock.lock_seq,
        view,
        now,
        lifetime,
    ) {
        Ok(plan) => {
            let valid_until = plan.valid_until();
            let ticket = service.issuer.sign(plan);
            json!({
                "key": key, "lockSeq": lock.lock_seq, "status": "ok",
                "ticket": hex::encode(ticket.encode()), "validUntil": valid_until,
            })
        }
        Err(refusal) => refused(&key, lock.lock_seq, refusal),
    }
}

fn refused(key: &str, lock_seq: u32, refusal: Refusal) -> Value {
    json!({ "key": key, "lockSeq": lock_seq, "status": "refused", "reason": refusal.reason() })
}

async fn attester<R: ChainReader>(State(service): State<Arc<Service<R>>>) -> Json<Value> {
    Json(json!({
        "id": service.policy.attester,
        "authority": hex::encode(service.authority),
        "key": hex::encode(service.issuer.public()),
        "mint": hex::encode(service.policy.mint),
    }))
}

async fn revocations<R: ChainReader>(
    State(service): State<Arc<Service<R>>>,
) -> Result<Json<Value>, Error> {
    let text = match &service.revocations {
        Some(path) => std::fs::read_to_string(path).map_err(|_| Error::Unavailable)?,
        None => String::new(),
    };
    let mut notices = Vec::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let wire = hex::decode(line).map_err(|_| Error::Unavailable)?;
        Revocation::decode(&wire).map_err(|_| Error::Unavailable)?;
        notices.push(line.to_owned());
    }
    Ok(Json(json!({ "revocations": notices })))
}
