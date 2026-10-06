//! `POST /v1/relay` against the validator that runs the short-windows build: a sealed settlement
//! posted by a phone that is not its payer settles once, however many phones post it, and the
//! answer is readable by the payer only.
mod support;

use axum::{
    body::Body,
    extract::connect_info::MockConnectInfo,
    http::{Request, StatusCode, header},
};
use buckspay_gateway::{
    float::{Caps as FloatCaps, SettlementLimits},
    hpke::{HpkeKeys, info},
    janitor,
    jobs::{JobState, Jobs, SettlementJob},
    limits::RELAY_PREFIX,
    relay::{EXPORT_LABEL, MAX_RELAY_BYTES, RELAY_AAD, Relay},
    server::ClientAddress,
    sponsor::SponsorLimits,
};
use buckspay_protocol::{Caveats, Outputs, cluster::DEVNET_GENESIS_HASH, lock::Windows};
use chacha20poly1305::{
    ChaCha20Poly1305, Key, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use hkdf::Hkdf;
use hpke::{
    Deserializable, OpModeS, Serializable, aead::ChaCha20Poly1305 as HpkeChaCha, kdf::HkdfSha256,
    kem::X25519HkdfSha256,
};
use http_body_util::BodyExt;
use serde_json::Value;
use sha2_v11::Sha256;
use solana_keypair::Keypair;
use solana_signer::Signer;
use std::{net::SocketAddr, num::NonZeroU32, sync::Arc};
use support::*;
use tower::ServiceExt;

type Kem = X25519HkdfSha256;

const BOND: u64 = 20_000_000;
const BACKING: u64 = 20_000_000;
const PAID: u64 = 2_000_000;
const W: Windows = Windows::SHORT;

/// An issuer with a lock, a gateway on the validator and a payee with a token account.
struct Relayed {
    sponsor: Sponsor,
    issuer: Issuer,
    payee: Wallet,
    next: u64,
}

fn float_caps_with(change: impl FnOnce(&mut FloatCaps)) -> Arc<SettlementLimits> {
    let mut caps = float_caps();
    change(&mut caps);
    SettlementLimits::new(caps)
}

async fn gateway(
    float: Arc<SettlementLimits>,
    relay: Relay,
    jobs: Jobs,
    per_minute: u32,
) -> Sponsor {
    Sponsor::on_relay(
        rpc(&cluster().url),
        funded(1_000_000_000).await,
        SponsorLimits::new(caps()),
        float,
        settings(),
        ClientAddress::Peer,
        rents().await,
        per_minute,
        jobs,
        relay,
    )
}

impl Relayed {
    async fn on(sponsor: Sponsor) -> Self {
        let issuer = Issuer::new(&sponsor, BOND, BACKING, W.min_lock() + 600).await;
        Self {
            sponsor,
            issuer,
            payee: associated_wallet(0).await,
            next: 0,
        }
    }

    async fn start() -> Self {
        Self::on(gateway(float_caps_with(|_| {}), instant(), Jobs::default(), 1_000).await).await
    }

    async fn expiry(&self) -> u32 {
        chain_now().await + W.min_note_life + 3_600
    }

    /// A one-spend note of `PAID` to the payee, from the next free part of the backing.
    async fn note(&mut self) -> Note {
        let expiry = self.expiry().await;
        let note = self
            .issuer
            .issue_to_self(self.next, PAID, expiry)
            .settle_to(&self.issuer.device, 0, &self.payee.keypair.pubkey());
        self.next += PAID;
        note
    }
}

fn instant() -> Relay {
    Relay::with_delay(0)
}

/// The gateway's key as the app pins it.
fn gateway_key() -> (u8, <Kem as hpke::Kem>::PublicKey) {
    let published = hpke_keys().published().remove(0);
    let public = base64_decode(&published.public_key);
    (
        published.key_id,
        <Kem as hpke::Kem>::PublicKey::from_bytes(&public).unwrap(),
    )
}

fn hpke_keys() -> HpkeKeys {
    support::hpke()
}

fn base64_decode(value: &str) -> Vec<u8> {
    use base64::{Engine, prelude::BASE64_STANDARD};
    BASE64_STANDARD.decode(value).unwrap()
}

/// What the payer keeps to read the answer: the exporter secret and `enc`.
struct Opener {
    secret: [u8; 32],
    enc: [u8; 32],
}

impl Opener {
    /// The JSON the gateway sealed, or `None` when the body is not for this payer.
    fn open(&self, body: &[u8]) -> Option<Value> {
        let (nonce, ciphertext) = body.split_at_checked(32)?;
        let mut salt = [0u8; 64];
        salt[..32].copy_from_slice(&self.enc);
        salt[32..].copy_from_slice(nonce);
        let hkdf = Hkdf::<Sha256>::new(Some(&salt), &self.secret);
        let (mut key, mut iv) = ([0u8; 32], [0u8; 12]);
        hkdf.expand(b"key", &mut key).unwrap();
        hkdf.expand(b"nonce", &mut iv).unwrap();
        let plain = ChaCha20Poly1305::new(&Key::from(key))
            .decrypt(
                &Nonce::from(iv),
                Payload {
                    msg: ciphertext,
                    aad: b"",
                },
            )
            .ok()?;
        assert_eq!(plain.len(), 256, "every answer has the same length");
        let end = plain.iter().rposition(|byte| *byte != 0)? + 1;
        serde_json::from_slice(&plain[..end]).ok()
    }

    fn status(&self, body: &[u8]) -> String {
        self.open(body).expect("the answer opens")["status"]
            .as_str()
            .unwrap()
            .to_owned()
    }
}

fn inner(note: &Note, bucket: usize) -> Vec<u8> {
    let issue = hex::decode(note.issue_hex()).unwrap();
    let spends: Vec<Vec<u8>> = note
        .spend_hexes()
        .iter()
        .map(|spend| hex::decode(spend).unwrap())
        .collect();
    let mut plain = vec![1u8, 1];
    plain.extend((issue.len() as u16).to_be_bytes());
    plain.extend(&issue);
    plain.push(spends.len() as u8);
    for spend in &spends {
        plain.extend((spend.len() as u16).to_be_bytes());
        plain.extend(spend);
    }
    plain.resize(bucket, 0);
    plain
}

fn seal_with(
    key_id: u8,
    public: &<Kem as hpke::Kem>::PublicKey,
    purpose: &str,
    genesis: [u8; 32],
    plain: &[u8],
) -> (Vec<u8>, Opener) {
    let (enc, mut context) = hpke::setup_sender::<HpkeChaCha, HkdfSha256, Kem>(
        &OpModeS::Base,
        public,
        &info(purpose, &genesis),
    )
    .unwrap();
    let ciphertext = context.seal(plain, RELAY_AAD).unwrap();
    let mut secret = [0u8; 32];
    context.export(EXPORT_LABEL, &mut secret).unwrap();
    let enc: [u8; 32] = enc.to_bytes().as_slice().try_into().unwrap();
    let mut blob = vec![key_id];
    blob.extend(enc);
    blob.extend(ciphertext);
    (blob, Opener { secret, enc })
}

fn seal_relay(note: &Note, bucket: usize) -> (Vec<u8>, Opener) {
    let (key_id, public) = gateway_key();
    seal_with(
        key_id,
        &public,
        "relay",
        DEVNET_GENESIS_HASH,
        &inner(note, bucket),
    )
}

async fn post_relay(sponsor: &Sponsor, peer: &str, body: Vec<u8>) -> (StatusCode, Vec<u8>) {
    let peer: SocketAddr = format!("{peer}:4000").parse().unwrap();
    let request = Request::post("/v1/relay")
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(Body::from(body))
        .unwrap();
    let response = sponsor
        .app
        .clone()
        .layer(MockConnectInfo(peer))
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status();
    (
        status,
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
}

async fn relayed(sponsor: &Sponsor, peer: &str, note: &Note) -> String {
    let (blob, open) = seal_relay(note, 1024);
    let (status, body) = post_relay(sponsor, peer, blob).await;
    assert_eq!(status, StatusCode::OK);
    open.status(&body)
}

/// Waits until the payee holds `amount`: the spawned driver and the janitor send in the background.
async fn paid(t: &Relayed, amount: u64) {
    for _ in 0..240 {
        janitor::run_once(&t.sponsor.gateway, janitor::ROTATION_GRACE)
            .await
            .unwrap();
        if token_balance(&t.payee.token).await >= amount {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    assert_eq!(token_balance(&t.payee.token).await, amount);
}

#[tokio::test]
async fn a_relayed_settlement_settles_once_and_the_copy_is_a_duplicate() {
    let mut t = Relayed::start().await;
    let note = t.note().await;
    let (blob, open) = seal_relay(&note, 1024);
    let started = std::time::Instant::now();
    let (status, first) = post_relay(&t.sponsor, "203.0.113.1", blob.clone()).await;
    eprintln!(
        "relay post to sealed answer: {} ms",
        started.elapsed().as_millis()
    );
    assert_eq!(
        (status, open.status(&first).as_str()),
        (StatusCode::OK, "submitted")
    );
    paid(&t, PAID).await;
    let (_, second) = post_relay(&t.sponsor, "198.51.100.2", blob).await;
    assert_eq!(open.status(&second), "duplicate");
    let (_, other) = seal_relay(&note, 1024);
    assert!(
        other.open(&second).is_none(),
        "another payer cannot read the answer"
    );
    assert_eq!(token_balance(&t.payee.token).await, PAID);
}

#[tokio::test]
async fn a_payment_to_an_account_with_no_spend_settles_through_the_relay() {
    let mut t = Relayed::start().await;
    let expiry = t.expiry().await;
    let note = t
        .issuer
        .issue_to_account(t.next, PAID, expiry, &t.payee.keypair.pubkey());
    t.next += PAID;
    assert!(note.spends.is_empty());
    assert_eq!(relayed(&t.sponsor, "203.0.113.9", &note).await, "submitted");
    paid(&t, PAID).await;
}

#[tokio::test]
async fn nothing_reaches_the_rpc_before_the_blob_opens() {
    let sponsor = Sponsor::on_relay(
        rpc(NOWHERE),
        funded(1_000_000_000).await,
        SponsorLimits::new(caps()),
        SettlementLimits::new(float_caps()),
        settings(),
        ClientAddress::Peer,
        rents().await,
        1_000,
        Jobs::default(),
        instant(),
    );
    let mut t = Relayed::start().await;
    let note = t.note().await;
    let (blob, _) = seal_relay(&note, 1024);
    let (key_id, public) = gateway_key();
    let mut unknown = blob.clone();
    unknown[0] = key_id.wrapping_add(1);
    let mut flipped = blob.clone();
    *flipped.last_mut().unwrap() ^= 1;
    let wrong_purpose = seal_with(
        key_id,
        &public,
        "settlement",
        DEVNET_GENESIS_HASH,
        &inner(&note, 1024),
    )
    .0;
    let wrong_cluster = seal_with(key_id, &public, "relay", [9; 32], &inner(&note, 1024)).0;
    let mut padded_wrong = inner(&note, 1024);
    *padded_wrong.last_mut().unwrap() = 1;
    let unparsable = seal_with(key_id, &public, "relay", DEVNET_GENESIS_HASH, &padded_wrong).0;
    for body in [
        vec![0u8; 100],
        unknown,
        flipped,
        wrong_purpose,
        wrong_cluster,
        unparsable,
    ] {
        let (status, _) = post_relay(&sponsor, "203.0.113.1", body).await;
        assert!(status.is_client_error(), "{status}");
    }
    // A blob that does open reaches the RPC, which here is nowhere: it is asked to retry, not refused.
    let (status, body) = post_relay(&sponsor, "203.0.113.1", blob).await;
    assert_eq!(status, StatusCode::OK, "{}", body.len());
}

#[tokio::test]
async fn a_body_over_the_relay_limit_is_refused_by_the_layer() {
    let mut t = Relayed::start().await;
    let (status, _) = post_relay(&t.sponsor, "203.0.113.1", vec![0u8; MAX_RELAY_BYTES + 1]).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    let note = t.note().await;
    let (blob, open) = seal_relay(&note, 8192);
    assert_eq!(blob.len(), MAX_RELAY_BYTES);
    let (status, body) = post_relay(&t.sponsor, "203.0.113.1", blob).await;
    assert_eq!(
        (status, open.status(&body).as_str()),
        (StatusCode::OK, "submitted")
    );
}

#[tokio::test]
async fn relayed_settlements_count_against_the_same_per_key_limit_as_direct_ones() {
    let sponsor = gateway(
        float_caps_with(|c| c.per_key_per_day = 1),
        instant(),
        Jobs::default(),
        1_000,
    )
    .await;
    let mut t = Relayed::on(sponsor).await;
    let first = t.note().await;
    let (status, body) = t
        .sponsor
        .post("/v1/settlements", &first.settlement_request())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let second = t.note().await;
    let (blob, open) = seal_relay(&second, 1024);
    let (_, answer) = post_relay(&t.sponsor, "203.0.113.9", blob).await;
    assert_eq!(open.status(&answer), "retry");
    assert!(t.sponsor.gateway.jobs.pending().is_empty());
}

#[tokio::test]
async fn three_copies_posted_concurrently_land_once() {
    let mut t = Relayed::start().await;
    let note = t.note().await;
    let copies: Vec<_> = (0..3).map(|_| seal_relay(&note, 1024)).collect();
    let peers = ["203.0.113.1", "198.51.100.2", "192.0.2.3"];
    let post = |i: usize| post_relay(&t.sponsor, peers[i], copies[i].0.clone());
    let (a, b, c) = tokio::join!(post(0), post(1), post(2));
    let answers = [a, b, c];
    let mut statuses: Vec<String> = answers
        .iter()
        .zip(&copies)
        .map(|((_, body), (_, open))| open.status(body))
        .collect();
    statuses.sort();
    assert_eq!(statuses, ["duplicate", "duplicate", "submitted"]);
    paid(&t, PAID).await;
}

fn rows_on_disk(path: &std::path::Path) -> usize {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Map<String, Value>>(&bytes).ok())
        .map_or(0, |rows| rows.len())
}

#[tokio::test]
async fn a_relayed_single_batch_job_is_persisted_before_the_answer() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("jobs.json");
    let sponsor = gateway(
        float_caps_with(|_| {}),
        Relay::with_delay(30),
        Jobs::open(&path).unwrap(),
        1_000,
    )
    .await;
    let mut t = Relayed::on(sponsor).await;
    let note = t.note().await;
    assert_eq!(relayed(&t.sponsor, "203.0.113.1", &note).await, "submitted");
    assert_eq!(rows_on_disk(&path), 1);
    let mut tampered = inner(&t.note().await, 1024);
    tampered[20] ^= 1;
    let (key_id, public) = gateway_key();
    let (blob, open) = seal_with(key_id, &public, "relay", DEVNET_GENESIS_HASH, &tampered);
    let (_, body) = post_relay(&t.sponsor, "203.0.113.1", blob).await;
    assert_eq!(open.status(&body), "refused");
    assert_eq!(rows_on_disk(&path), 1);
    let job = Jobs::open(&path).unwrap().pending().remove(0);
    let at = job.not_before.expect("a relayed job waits");
    assert!(at <= chain_now().await + 31 && job.prefix == RELAY_PREFIX);
}

#[tokio::test]
async fn a_retry_never_ends_the_job_or_the_note() {
    let mut t = Relayed::start().await;
    let late = Keypair::new();
    let expiry = t.expiry().await;
    let note =
        t.issuer
            .issue_to_self(0, PAID, expiry)
            .settle_to(&t.issuer.device, 0, &late.pubkey());
    assert_eq!(relayed(&t.sponsor, "203.0.113.1", &note).await, "retry");
    assert!(t.sponsor.gateway.jobs.pending().is_empty());
    let payee = associated_wallet_of(&late, 0).await;
    assert_eq!(
        relayed(&t.sponsor, "198.51.100.2", &note).await,
        "submitted"
    );
    t.payee = payee;
    paid(&t, PAID).await;
}

#[tokio::test]
async fn relayed_settlements_and_junk_do_not_consume_the_relayers_direct_quota() {
    let float = float_caps_with(|c| c.per_prefix_per_day = 2);
    let mut t = Relayed::on(gateway(float, instant(), Jobs::default(), 5).await).await;
    for _ in 0..3 {
        let note = t.note().await;
        assert_eq!(relayed(&t.sponsor, "203.0.113.1", &note).await, "submitted");
    }
    paid(&t, 3 * PAID).await;
    let junk = vec![0u8; 1024 + 49];
    for _ in 0..20 {
        post_relay(&t.sponsor, "203.0.113.7", junk.clone()).await;
    }
    let note = t.note().await;
    let (status, body) = t
        .sponsor
        .post_from(
            "203.0.113.7:4000",
            "/v1/settlements",
            note.settlement_request().to_string(),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn junk_posted_through_a_relayer_is_counted_in_the_relay_buckets() {
    let relay = Relay::new(
        0,
        NonZeroU32::new(3).unwrap(),
        NonZeroU32::new(100).unwrap(),
    );
    let t =
        Relayed::on(gateway(float_caps_with(|_| {}), relay, Jobs::default(), 1_000).await).await;
    let mut seen = Vec::new();
    for _ in 0..5 {
        seen.push(
            post_relay(&t.sponsor, "203.0.113.7", vec![0u8; 100])
                .await
                .0,
        );
    }
    assert_eq!(&seen[..3], [StatusCode::BAD_REQUEST; 3]);
    assert_eq!(&seen[3..], [StatusCode::TOO_MANY_REQUESTS; 2]);
    let (status, _) = post_relay(&t.sponsor, "198.51.100.2", vec![0u8; 100]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn relayed_fees_draw_on_the_existing_daily_budget() {
    let float = float_caps_with(|c| c.daily_cap = 3);
    let mut t = Relayed::on(gateway(float, instant(), Jobs::default(), 1_000).await).await;
    for landed in 1..=3 {
        let note = t.note().await;
        assert_eq!(relayed(&t.sponsor, "203.0.113.1", &note).await, "submitted");
        paid(&t, landed * PAID).await;
    }
    let note = t.note().await;
    assert_eq!(relayed(&t.sponsor, "203.0.113.1", &note).await, "retry");
    assert_eq!(token_balance(&t.payee.token).await, 3 * PAID);
}

#[tokio::test]
async fn a_conflicting_relayed_settlement_is_refused_and_claimed_like_a_direct_one() {
    let t = Relayed::start().await;
    let expiry = t.expiry().await;
    let victim = Device::random();
    let victim_wallet = associated_wallet(0).await;
    let winner = t.issuer.issue_to_self(0, PAID, expiry).settle_to(
        &t.issuer.device,
        0,
        &t.payee.keypair.pubkey(),
    );
    let paid_note = t.issuer.issue_to_self(0, PAID, expiry).spend(
        &t.issuer.device,
        0,
        Outputs::One {
            owner: victim.owner(),
            caveats: Caveats {
                hops_left: 5,
                ..winner.issue.message.caveats
            },
        },
        0,
    );
    let payment = paid_note.last.first.id;
    let loser = paid_note.settle_to(&victim, 0, &victim_wallet.keypair.pubkey());
    let (status, body) = t
        .sponsor
        .post("/v1/settlements", &winner.settlement_request())
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(relayed(&t.sponsor, "203.0.113.1", &loser).await, "refused");
    let claim = solana_pubkey::Pubkey::new_from_array(
        buckspay_protocol::record::claim_address(&program().id().to_bytes(), &payment).unwrap(),
    );
    for _ in 0..120 {
        if account(&claim).await.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    assert!(account(&claim).await.is_some(), "the loss was claimed");
}

fn job_of(note: &Note, not_before: Option<u32>) -> SettlementJob {
    SettlementJob {
        key: "job".into(),
        issue: note.issue_hex(),
        spends: note.spend_hexes(),
        prefix: RELAY_PREFIX,
        created_at: 1,
        deadline: u32::MAX,
        batches_done: 0,
        state: JobState::Pending,
        last_signature: None,
        last_valid_block_height: None,
        not_before,
    }
}

#[tokio::test]
async fn a_relayed_job_waits_for_its_delay_and_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("jobs.json");
    let mut t = Relayed::start().await;
    let note = t.note().await;
    let far = chain_now().await + 3_600;
    Jobs::open(&path)
        .unwrap()
        .begin(job_of(&note, Some(far)))
        .unwrap();
    let restarted = gateway(
        float_caps_with(|_| {}),
        instant(),
        Jobs::open(&path).unwrap(),
        1_000,
    )
    .await;
    assert_eq!(
        restarted.gateway.jobs.get("job").unwrap().not_before,
        Some(far)
    );
    janitor::run_once(&restarted.gateway, janitor::ROTATION_GRACE)
        .await
        .unwrap();
    assert_eq!(
        token_balance(&t.payee.token).await,
        0,
        "nothing is sent before its time"
    );
    let ready = gateway(
        float_caps_with(|_| {}),
        instant(),
        Jobs::open(&dir.path().join("ready.json")).unwrap(),
        1_000,
    )
    .await;
    ready.gateway.jobs.begin(job_of(&note, Some(1))).unwrap();
    janitor::run_once(&ready.gateway, janitor::ROTATION_GRACE)
        .await
        .unwrap();
    paid(&t, PAID).await;
}

#[tokio::test]
async fn the_published_keys_carry_their_slot() {
    let sponsor = gateway(float_caps_with(|_| {}), instant(), Jobs::default(), 1_000).await;
    let (status, body) = sponsor.get("203.0.113.1:4000", "/v1/hpke-config").await;
    assert_eq!(status, StatusCode::OK);
    let key = &body["keys"][0];
    assert!(
        key["notBefore"].is_u64() && key["notAfter"].is_u64(),
        "{body}"
    );
}

#[test]
fn opening_and_parsing_a_blob_is_quick_and_every_answer_is_the_same_size() {
    use buckspay_gateway::relay::{RESPONSE_PAD, parse_inner};
    let (key_id, public) = gateway_key();
    let keys = hpke_keys();
    let context = info("relay", &DEVNET_GENESIS_HASH);
    for bucket in [1024usize, 2048, 4096, 8192] {
        let mut plain = vec![1u8, 1];
        plain.extend(140u16.to_be_bytes());
        plain.extend([7u8; 140]);
        plain.push(1);
        plain.extend(150u16.to_be_bytes());
        plain.extend([8u8; 150]);
        plain.resize(bucket, 0);
        let (blob, _) = seal_with(key_id, &public, "relay", DEVNET_GENESIS_HASH, &plain);
        let started = std::time::Instant::now();
        let runs = 200;
        for _ in 0..runs {
            let (opened, _) = keys
                .open_with_export_at(
                    1_800_000_000,
                    blob[0],
                    &blob[1..33],
                    &blob[33..],
                    &context,
                    RELAY_AAD,
                    EXPORT_LABEL,
                )
                .unwrap();
            parse_inner(&opened).unwrap();
        }
        let micros = started.elapsed().as_micros() / runs;
        eprintln!(
            "relay open+parse {bucket} B bucket: {micros} us, blob {} B, answer {} B",
            blob.len(),
            32 + RESPONSE_PAD + 16
        );
        // A debug build runs the crypto an order of magnitude slower than the release one.
        assert!(
            micros
                < if cfg!(debug_assertions) {
                    100_000
                } else {
                    1_000
                }
        );
    }
}
