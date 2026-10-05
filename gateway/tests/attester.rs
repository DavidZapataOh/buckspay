//! The attester's HTTP side against a chain reader that says what the test tells it, and its
//! limits. The reader against a validator is `attester_chain.rs`.
use axum::{
    Router,
    body::Body,
    extract::connect_info::MockConnectInfo,
    http::{Request, StatusCode, header},
};
use buckspay_client::Program;
use buckspay_gateway::{
    attester::{
        limits::{Limits, Settings},
        plan::{ChainView, Issuer, Policy},
        reader::{ChainReader, LockId, Providers, ReadError, Snapshot},
        server::{Service, router},
    },
    server::ClientAddress,
};
use buckspay_protocol::{
    Owner,
    attest::LockRecord,
    ticket::{Attester, Need, accept},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::{
    net::SocketAddr,
    num::NonZeroU32,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
};
use tower::ServiceExt;

const NOW: u32 = 1_900_000_000;
const MINT: [u8; 32] = [3; 32];
const DOMAIN: [u8; 32] = [10; 32];
const DAY: u32 = 86_400;
const PEER: &str = "203.0.113.7:4000";

#[derive(Clone)]
struct Fake {
    answer: Arc<Mutex<Result<Vec<ChainView>, ReadError>>>,
    skew: Arc<Mutex<i64>>,
    clock: Arc<AtomicU32>,
    reads: Arc<AtomicU32>,
}

impl ChainReader for Fake {
    async fn read(&self, locks: &[LockId]) -> Result<Snapshot, ReadError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let views = self.answer.lock().unwrap().clone()?;
        let unix = i64::from(self.clock.load(Ordering::SeqCst)) + *self.skew.lock().unwrap();
        Ok(Snapshot {
            unix,
            views: locks.iter().map(|_| views[0]).collect(),
        })
    }
}

fn whole() -> ChainView {
    ChainView {
        lock: Some(LockRecord {
            mint: MINT,
            bond: 400,
            backing: 10_000,
            lock_until: NOW + 90 * DAY,
        }),
        bond_free: 400,
        bond_slashed: 0,
    }
}

struct World {
    app: Router,
    fake: Fake,
    service: Arc<Service<Fake>>,
}

fn world_with(settings: Settings) -> World {
    let clock = Arc::new(AtomicU32::new(NOW));
    let fake = Fake {
        answer: Arc::new(Mutex::new(Ok(vec![whole()]))),
        skew: Arc::new(Mutex::new(0)),
        clock: Arc::clone(&clock),
        reads: Arc::default(),
    };
    let policy = Policy {
        attester: 1,
        mint: MINT,
        lifetimes: [DAY, 71 * 3_600],
        quantum: 3_600,
    };
    let mut service = Service::new(
        fake.clone(),
        Issuer::new([11; 32], DOMAIN),
        policy,
        [13; 32],
        Limits::in_memory(settings),
        None,
    );
    service.clock = Box::new(move || clock.load(Ordering::SeqCst));
    let service = Arc::new(service);
    let app = router(Arc::clone(&service), ClientAddress::Peer)
        .layer(MockConnectInfo(PEER.parse::<SocketAddr>().unwrap()));
    World { app, fake, service }
}

fn world() -> World {
    world_with(Settings {
        per_minute: NonZeroU32::new(1_000).unwrap(),
        per_network_day: 100_000,
        per_key_day: 100_000,
        capacity: 100_000,
    })
}

fn device(seed: u8) -> String {
    let mut key = [seed; 33];
    key[0] = 2;
    hex::encode(key)
}

fn ask(locks: &[(u8, u32)], lifetime: u32) -> String {
    let locks: Vec<Value> = locks
        .iter()
        .map(|(seed, seq)| json!({ "key": device(*seed), "lockSeq": seq }))
        .collect();
    json!({ "locks": locks, "lifetime": lifetime }).to_string()
}

async fn post(app: &Router, body: String) -> (StatusCode, Value) {
    let request = Request::post("/v1/tickets")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn a_ticket_is_issued_for_a_whole_lock_and_verifies_in_the_wallet() {
    let w = world();
    let (status, body) = post(&w.app, ask(&[(7, 0)], DAY)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let result = &body["results"][0];
    assert_eq!(result["status"], "ok");
    let wire = hex::decode(result["ticket"].as_str().unwrap()).unwrap();
    assert_eq!(wire.len(), 161);
    let ticket = buckspay_protocol::BondTicket::decode(&wire).unwrap();
    let issuer = Issuer::new([11; 32], DOMAIN);
    let registry = Attester::new(1, [13; 32], MINT, 1_000, issuer.public(), NOW);
    let mut device = [7; 33];
    device[0] = 2;
    let need = Need {
        mint: &MINT,
        amount: 100,
        backing: Some(5_000),
        expiry: NOW + 3 * 3_600,
    };
    let liability = accept(
        NOW,
        &DOMAIN,
        &[registry],
        &[ticket],
        &Owner::Device(device),
        0,
        &need,
    )
    .unwrap();
    assert_eq!((liability.bond, liability.attester), (400, 1));
    assert_eq!(result["validUntil"], ticket.valid_until);
}

#[tokio::test]
async fn nothing_is_signed_for_another_mint_a_missing_lock_an_impaired_one_or_a_short_one() {
    let w = world();
    let lock = whole().lock.unwrap();
    let cases = [
        (
            ChainView {
                lock: None,
                ..whole()
            },
            "lock_absent",
        ),
        (
            ChainView {
                lock: Some(LockRecord {
                    mint: [4; 32],
                    ..lock
                }),
                ..whole()
            },
            "wrong_mint",
        ),
        (
            ChainView {
                bond_free: 300,
                ..whole()
            },
            "impaired",
        ),
        (
            ChainView {
                lock: Some(LockRecord {
                    lock_until: NOW + DAY,
                    ..lock
                }),
                ..whole()
            },
            "lock_too_short",
        ),
    ];
    for (view, reason) in cases {
        *w.fake.answer.lock().unwrap() = Ok(vec![view]);
        let (status, body) = post(&w.app, ask(&[(7, 0)], DAY)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["results"][0]["status"], "refused");
        assert_eq!(body["results"][0]["reason"], reason);
        assert!(body["results"][0].get("ticket").is_none());
    }
}

#[tokio::test]
async fn equal_requests_in_one_hour_get_equal_bytes_and_the_next_hour_differs() {
    let w = world();
    let at = |unix: u32| {
        w.fake.clock.store(unix, Ordering::SeqCst);
        async { post(&w.app, ask(&[(7, 0)], DAY)).await.1["results"][0]["ticket"].clone() }
    };
    let start = NOW - NOW % 3_600;
    let (a, b, c) = (
        at(start).await,
        at(start + 3_540).await,
        at(start + 3_600).await,
    );
    assert_eq!(a, b);
    assert_ne!(a, c);
}

#[tokio::test]
async fn the_lifetime_is_one_of_two_and_never_more_than_71_hours() {
    let w = world();
    for lifetime in [DAY, 255_600] {
        assert_eq!(
            post(&w.app, ask(&[(7, 0)], lifetime)).await.0,
            StatusCode::OK
        );
    }
    for lifetime in [DAY + 1, 259_200, 0] {
        assert_eq!(
            post(&w.app, ask(&[(7, 0)], lifetime)).await.0,
            StatusCode::BAD_REQUEST,
            "{lifetime}"
        );
    }
}

#[tokio::test]
async fn a_batch_is_at_most_eight_locks_and_a_body_at_most_one_kib() {
    let w = world();
    let eight: Vec<(u8, u32)> = (0..8).map(|n| (7, n)).collect();
    let nine: Vec<(u8, u32)> = (0..9).map(|n| (7, n)).collect();
    assert_eq!(post(&w.app, ask(&eight, DAY)).await.0, StatusCode::OK);
    assert_eq!(
        post(&w.app, ask(&nine, DAY)).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(post(&w.app, ask(&[], DAY)).await.0, StatusCode::BAD_REQUEST);
    let reads = w.fake.reads.load(Ordering::SeqCst);
    assert_eq!(
        post(&w.app, "x".repeat(1_025)).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(w.fake.reads.load(Ordering::SeqCst), reads);
}

#[tokio::test]
async fn malformed_requests_cost_no_chain_read() {
    let w = world();
    let mut key = [7; 33];
    key[0] = 4;
    let bad = [
        "not json".to_owned(),
        json!({ "locks": [{ "key": "00", "lockSeq": 0 }], "lifetime": DAY }).to_string(),
        json!({ "locks": [{ "key": hex::encode(key), "lockSeq": 0 }], "lifetime": DAY })
            .to_string(),
        json!({ "locks": [{ "key": device(7), "lockSeq": u32::MAX }], "lifetime": DAY })
            .to_string(),
        json!({ "locks": [{ "key": device(7), "lockSeq": 0, "extra": 1 }], "lifetime": DAY })
            .to_string(),
    ];
    for body in bad {
        assert_eq!(
            post(&w.app, body.clone()).await.0,
            StatusCode::BAD_REQUEST,
            "{body}"
        );
    }
    assert_eq!(w.fake.reads.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn the_service_refuses_when_its_clock_disagrees_with_the_chain() {
    let w = world();
    for (skew, expected) in [
        (30, StatusCode::OK),
        (-30, StatusCode::OK),
        (31, StatusCode::SERVICE_UNAVAILABLE),
        (-31, StatusCode::SERVICE_UNAVAILABLE),
    ] {
        *w.fake.skew.lock().unwrap() = skew;
        let (status, body) = post(&w.app, ask(&[(7, 0)], DAY)).await;
        assert_eq!(status, expected, "{skew}");
        if expected != StatusCode::OK {
            assert!(body.get("results").is_none());
        }
    }
}

#[tokio::test]
async fn providers_that_disagree_or_fail_get_no_ticket() {
    let w = world();
    for error in [ReadError::Disagree, ReadError::Unavailable] {
        *w.fake.answer.lock().unwrap() = Err(error);
        let (status, body) = post(&w.app, ask(&[(7, 0)], DAY)).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["retryAfter"], 30);
    }
}

#[test]
fn two_providers_must_be_two_hosts() {
    let program = Program::new(solana_pubkey::Pubkey::new_unique());
    assert!(Providers::new(program, ["http://a.example/x", "https://a.example/y"]).is_err());
    assert!(Providers::new(program, ["http://a.example", "http://b.example"]).is_ok());
}

#[tokio::test]
async fn limits_count_refusals_and_failures_and_a_network_is_throttled_whatever_the_answers() {
    let w = world_with(Settings {
        per_minute: NonZeroU32::new(60).unwrap(),
        ..Settings::pilot()
    });
    *w.fake.answer.lock().unwrap() = Err(ReadError::Unavailable);
    for n in 0..60u8 {
        assert_eq!(
            post(&w.app, ask(&[(n, 0)], DAY)).await.0,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
    let reads = w.fake.reads.load(Ordering::SeqCst);
    assert_eq!(
        post(&w.app, ask(&[(7, 0)], DAY)).await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(w.fake.reads.load(Ordering::SeqCst), reads);
}

#[tokio::test]
async fn a_key_has_a_daily_budget_that_counts_every_ask_and_resets_the_next_day() {
    let w = world_with(Settings {
        per_key_day: 48,
        ..Settings::pilot()
    });
    *w.fake.answer.lock().unwrap() = Ok(vec![ChainView {
        lock: None,
        ..whole()
    }]);
    for _ in 0..6 {
        let eight: Vec<(u8, u32)> = (0..8).map(|n| (9, n)).collect();
        assert_eq!(post(&w.app, ask(&eight, DAY)).await.0, StatusCode::OK);
    }
    assert_eq!(
        post(&w.app, ask(&[(9, 0)], DAY)).await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(post(&w.app, ask(&[(8, 0)], DAY)).await.0, StatusCode::OK);
    w.fake.clock.store(NOW + DAY, Ordering::SeqCst);
    assert_eq!(post(&w.app, ask(&[(9, 0)], DAY)).await.0, StatusCode::OK);
}

#[test]
fn the_counters_are_swept_bounded_and_survive_a_restart_without_an_address() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("attester-counts.json");
    let settings = Settings {
        capacity: 50,
        per_key_day: 3,
        ..Settings::pilot()
    };
    let limits = Limits::open(settings, &path, NOW).unwrap();
    for n in 0..200u32 {
        let mut key = [0u8; 33];
        key[0] = 2;
        key[1..5].copy_from_slice(&n.to_le_bytes());
        let _ = limits.admit_keys(&[key], NOW);
    }
    assert_eq!(limits.held().1, 50);
    let ip: std::net::IpAddr = "203.0.113.7".parse().unwrap();
    for _ in 0..3 {
        let _ = limits.admit_network(buckspay_gateway::limits::Prefix::from(ip), NOW);
    }
    let mut hot = [5u8; 33];
    hot[0] = 3;
    for _ in 0..3 {
        limits.admit_keys(&[hot], NOW).unwrap();
    }
    assert!(limits.admit_keys(&[hot], NOW).is_err());
    limits.persist().unwrap();

    let text = std::fs::read_to_string(&path).unwrap();
    assert!(!text.contains("203.0.113"), "an address reached the file");
    assert!(!text.contains(&hex::encode(hot)), "a key reached the file");

    let again = Limits::open(settings, &path, NOW + 5).unwrap();
    assert!(again.admit_keys(&[hot], NOW + 5).is_err());
    assert_eq!(again.held().1, 50);
    // The next day everything is forgotten.
    let tomorrow = Limits::open(settings, &path, NOW + DAY).unwrap();
    tomorrow.admit_keys(&[hot], NOW + DAY).unwrap();
    assert_eq!(tomorrow.held(), (0, 1));
}

#[tokio::test]
async fn the_attester_describes_itself_and_serves_the_revocations_its_authority_wrote() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("revocations.txt");
    let notice = buckspay_protocol::attest::Revocation {
        attester: 1,
        key: [9; 32],
        signature: [5; 64],
    };
    std::fs::write(&file, format!("{}\n", hex::encode(notice.encode()))).unwrap();
    let mut w = world();
    let mut service = Service::new(
        w.fake.clone(),
        Issuer::new([11; 32], DOMAIN),
        w.service.policy,
        [13; 32],
        Limits::in_memory(Settings::pilot()),
        Some(file),
    );
    service.clock = Box::new(|| NOW);
    w.app = router(Arc::new(service), ClientAddress::Peer)
        .layer(MockConnectInfo(PEER.parse::<SocketAddr>().unwrap()));
    let get = |path: &'static str| {
        let app = w.app.clone();
        async move {
            let response = app
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            serde_json::from_slice::<Value>(&bytes).unwrap()
        }
    };
    let me = get("/v1/attester").await;
    assert_eq!(me["id"], 1);
    assert_eq!(me["authority"], hex::encode([13u8; 32]));
    assert_eq!(me["mint"], hex::encode(MINT));
    let revocations = get("/v1/revocations").await;
    assert_eq!(revocations["revocations"][0], hex::encode(notice.encode()));
}

/// The signer never hands the key out and signs only what [`plan`] built: a test over the source,
/// as the payout lint is for tokens.
#[test]
fn the_key_never_leaves_the_signer() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/attester");
    let plan = std::fs::read_to_string(dir.join("plan.rs")).unwrap();
    let production = plan.split("#[cfg(test)]").next().unwrap();
    assert!(!production.contains("-> SigningKey") && !production.contains("-> &SigningKey"));
    assert!(!production.contains("pub key"));
    assert_eq!(production.matches("pub fn sign(").count(), 1);
    assert!(production.contains("pub fn sign(&self, plan: Plan)"));
    assert_eq!(production.matches("Ok(Plan(BondTicket").count(), 1);
    for file in ["server.rs", "reader.rs", "limits.rs", "mod.rs"] {
        let text = std::fs::read_to_string(dir.join(file)).unwrap();
        assert!(!text.contains("Plan("), "{file} builds a plan");
        assert!(!text.contains("SigningKey"), "{file} touches the key");
    }
    let main = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/attester_main.rs"),
    )
    .unwrap();
    assert!(!main.to_lowercase().contains("fee_payer") && !main.contains("hpke"));
}
