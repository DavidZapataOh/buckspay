//! The gateway's endpoints against an Agave 4.3 `solana-test-validator` (the CLI of 01-01 on
//! `PATH`) running the devnet build of the program (`anchor build -- --features devnet` first). Refusals that must happen before Solana is
//! read run against an RPC address where nothing listens: an answer other than `502` proves the
//! gateway refused without reading Solana.
use axum::{
    Router,
    body::Body,
    extract::connect_info::MockConnectInfo,
    http::{Request, StatusCode, header},
};
use base64::{Engine, prelude::BASE64_STANDARD};
use buckspay_client::{
    find_device_pda, instructions::RegisterDeviceBuilder, programs::BUCKSPAY_ID,
    register_device_compute_unit_limit,
};
use buckspay_gateway::{
    hpke::HpkeKeys,
    limits::{Caps, Limits},
    message,
    registration::{PENDING_TTL, PrepareResponse, registration_message},
    server::{BODY_DEADLINE, ClientAddress, Gateway, IN_FLIGHT, Settings, bind_unix, router},
};
use buckspay_protocol::{
    cluster::DEVNET_GENESIS_HASH,
    device::device_binding_envelope,
    hash::{domain, purpose},
};
use http_body_util::BodyExt;
use p256::ecdsa::{Signature as P256Signature, SigningKey, signature::Signer as _};
use serde_json::{Value, json};
use solana_commitment_config::CommitmentConfig;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_hash::Hash;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::VersionedMessage;
use solana_pubkey::Pubkey;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_secp256r1_program::new_secp256r1_instruction_with_signature;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::{
    fs,
    io::Write,
    net::{SocketAddr, TcpListener},
    num::NonZeroU32,
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tower::ServiceExt;

const PROGRAM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../anchor/target/deploy/buckspay.so"
);
/// Nothing listens here: any read of Solana fails, and the gateway answers `502`.
const NOWHERE: &str = "http://127.0.0.1:9";
const RENT: u64 = 1_176_240;

struct Cluster {
    url: String,
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// One Agave 4.3 `solana-test-validator` for the whole test binary, with the program at its id, on
/// ports nobody else uses. It runs under a shell that stops it once its stdin closes, which happens
/// when the test process exits, however it exits.
fn cluster() -> &'static Cluster {
    static CLUSTER: OnceLock<(Cluster, Mutex<Child>)> = OnceLock::new();
    let (cluster, _) = CLUSTER.get_or_init(|| {
        let ledger = Path::new(env!("CARGO_TARGET_TMPDIR")).join("gateway-ledger");
        // The RPC port and the next one, for its websocket.
        let rpc_port = loop {
            let port = free_port();
            if TcpListener::bind(("127.0.0.1", port + 1)).is_ok() {
                break port;
            }
        };
        let command = format!(
            "solana-test-validator --ledger {ledger} --reset --quiet --bind-address 127.0.0.1 \
             --rpc-port {rpc_port} --faucet-port {faucet} --gossip-port {gossip} \
             --upgradeable-program {program} {PROGRAM} none > {ledger}.log 2>&1 & \
             validator=$!; read -r _; kill $validator",
            ledger = ledger.display(),
            faucet = free_port(),
            gossip = free_port(),
            program = BUCKSPAY_ID,
        );
        let child = Command::new("bash")
            .args(["-c", &command])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let url = format!("http://127.0.0.1:{rpc_port}");
        let ready = thread::spawn({
            let url = url.clone();
            move || {
                let rpc = solana_rpc_client::rpc_client::RpcClient::new(url);
                (0..120).any(|_| {
                    thread::sleep(Duration::from_millis(500));
                    rpc.get_account(&BUCKSPAY_ID)
                        .is_ok_and(|program| program.executable)
                })
            }
        });
        assert!(ready.join().unwrap(), "the validator did not start");
        (Cluster { url }, Mutex::new(child))
    });
    cluster
}

fn rpc(url: &str) -> RpcClient {
    RpcClient::new_with_commitment(url.to_owned(), CommitmentConfig::confirmed())
}

/// A new account with `lamports` from the validator's faucet.
async fn funded(lamports: u64) -> Keypair {
    let rpc = rpc(&cluster().url);
    let account = Keypair::new();
    let signature = rpc
        .request_airdrop(&account.pubkey(), lamports)
        .await
        .unwrap();
    for _ in 0..60 {
        if rpc.confirm_transaction(&signature).await.unwrap() {
            return account;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("the airdrop to {} was not confirmed", account.pubkey());
}

async fn balance(account: &Pubkey) -> u64 {
    rpc(&cluster().url).get_balance(account).await.unwrap()
}

/// The device account of `key` once it is confirmed, within 30 s.
async fn device_account(key: &[u8; 33]) -> Option<solana_account::Account> {
    let rpc = rpc(&cluster().url);
    let (address, _) = find_device_pda(key);
    for _ in 0..60 {
        let found = rpc
            .get_account_with_commitment(&address, CommitmentConfig::confirmed())
            .await
            .unwrap()
            .value;
        if found.is_some() {
            return found;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    None
}

struct Device(SigningKey);

impl Device {
    fn new(seed: u8) -> Self {
        Self(SigningKey::from_slice(&[seed; 32]).unwrap())
    }
    fn random() -> Self {
        Self(SigningKey::from_slice(&Keypair::new().to_bytes()[..32]).unwrap())
    }
    fn key(&self) -> [u8; 33] {
        self.0
            .verifying_key()
            .to_sec1_point(true)
            .as_bytes()
            .try_into()
            .unwrap()
    }
    fn envelope(&self, wallet: &Pubkey) -> [u8; 96] {
        let domain = domain(
            purpose::DEVICE,
            &DEVNET_GENESIS_HASH,
            &BUCKSPAY_ID.to_bytes(),
        );
        device_binding_envelope(&domain, &wallet.to_bytes(), &self.key()).unwrap()
    }
    fn sign(&self, wallet: &Pubkey) -> [u8; 64] {
        let signature: P256Signature = self.0.sign(&self.envelope(wallet));
        signature.normalize_s().to_bytes().into()
    }
    fn request(&self, wallet: &Pubkey) -> Value {
        json!({
            "wallet": wallet.to_string(),
            "key": hex::encode(self.key()),
            "signature": hex::encode(self.sign(wallet)),
        })
    }
}

fn caps() -> Caps {
    Caps {
        requests_per_minute: NonZeroU32::new(1_000).unwrap(),
        per_prefix: 1_000,
        preparing_per_prefix: 1_000,
        window: Duration::from_secs(3600),
        outstanding: 1_000,
    }
}

fn settings() -> Settings {
    Settings {
        genesis_hash: DEVNET_GENESIS_HASH,
        max_priority_fee: 100_000,
        registration_cost: RENT + 3 * 5_000,
        pending_ttl: PENDING_TTL,
    }
}

fn hpke() -> HpkeKeys {
    HpkeKeys::from_secrets(&[[0x11; 32]]).unwrap()
}

struct Sponsor {
    fee_payer: Pubkey,
    app: Router,
}

impl Sponsor {
    /// A gateway on the test validator with its own funded fee payer.
    async fn new(caps: Caps) -> Self {
        Self::with_limits(Limits::new(caps)).await
    }

    async fn with_limits(limits: Limits) -> Self {
        let fee_payer = funded(1_000_000_000).await;
        Self::on(&cluster().url, fee_payer, limits, ClientAddress::Peer)
    }

    /// A gateway whose RPC is `url`, without funding.
    fn on(url: &str, fee_payer: Keypair, limits: Limits, client: ClientAddress) -> Self {
        Self::with_settings(url, fee_payer, limits, client, settings())
    }

    fn with_settings(
        url: &str,
        fee_payer: Keypair,
        limits: Limits,
        client: ClientAddress,
        settings: Settings,
    ) -> Self {
        Self {
            fee_payer: fee_payer.pubkey(),
            app: router(
                Gateway::new(rpc(url), fee_payer, settings, limits, hpke()),
                client,
            ),
        }
    }

    async fn send(&self, peer: &str, request: Request<Body>) -> (StatusCode, Value) {
        let peer: SocketAddr = peer.parse().unwrap();
        let response = self
            .app
            .clone()
            .layer(MockConnectInfo(peer))
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn post_from(&self, peer: &str, path: &str, body: String) -> (StatusCode, Value) {
        let request = Request::post(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap();
        self.send(peer, request).await
    }

    async fn post(&self, path: &str, body: &Value) -> (StatusCode, Value) {
        self.post_from("203.0.113.7:4000", path, body.to_string())
            .await
    }

    async fn sponsorship(&self, peer: &str) -> StatusCode {
        let request = Request::get("/v1/registrations/sponsorship")
            .body(Body::empty())
            .unwrap();
        self.send(peer, request).await.0
    }

    async fn prepare(&self, device: &Device, wallet: &Pubkey) -> PrepareResponse {
        let (status, body) = self
            .post("/v1/registrations", &device.request(wallet))
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        serde_json::from_value(body).unwrap()
    }

    async fn submit(&self, device: &Device, wire: &[u8]) -> (StatusCode, Value) {
        let body = json!({ "key": hex::encode(device.key()), "transaction": BASE64_STANDARD.encode(wire) });
        self.post("/v1/registrations/submit", &body).await
    }
}

/// `count ‖ signatures ‖ message`, the wire format of a transaction.
fn wire(signatures: &[Signature], message: &[u8]) -> Vec<u8> {
    let mut wire = vec![signatures.len() as u8];
    signatures
        .iter()
        .for_each(|signature| wire.extend_from_slice(signature.as_ref()));
    wire.extend_from_slice(message);
    wire
}

fn message_bytes(prepared: &PrepareResponse) -> Vec<u8> {
    let wire = BASE64_STANDARD.decode(&prepared.transaction).unwrap();
    assert_eq!(wire[0], 2);
    assert!(wire[1..129].iter().all(|byte| *byte == 0));
    wire[129..].to_vec()
}

fn signed_by(wallet: &Keypair, message: &[u8]) -> Vec<u8> {
    wire(
        &[Signature::default(), wallet.sign_message(message)],
        message,
    )
}

#[tokio::test]
async fn a_wallet_without_lamports_registers_and_the_gateway_pays() {
    let sponsor = Sponsor::new(caps()).await;
    let wallet = Keypair::new();
    let device = Device::random();
    let before = balance(&sponsor.fee_payer).await;
    let prepared = sponsor.prepare(&device, &wallet.pubkey()).await;
    assert_eq!(prepared.fee_payer, sponsor.fee_payer.to_string());
    // No recent fees on a fresh validator: the policy's price is 0.
    assert_eq!(prepared.compute_unit_price, 0);

    let bytes = message_bytes(&prepared);
    let message = registration_message(
        &sponsor.fee_payer,
        &wallet.pubkey(),
        &device.key(),
        &device.sign(&wallet.pubkey()),
        &device.envelope(&wallet.pubkey()),
        0,
        prepared.blockhash.parse().unwrap(),
    );
    assert_eq!(bytes, message.serialize());
    let VersionedMessage::V0(v0) = &message else {
        panic!("not a version 0 message")
    };
    assert!(v0.address_table_lookups.is_empty());
    assert_eq!(v0.header.num_required_signatures, 2);
    // The wallet is the second signer and the one read-only signed account: it pays nothing.
    assert_eq!(v0.header.num_readonly_signed_accounts, 1);
    assert_eq!(v0.account_keys[..2], [sponsor.fee_payer, wallet.pubkey()]);
    let (_, bump) = find_device_pda(&device.key());
    assert_eq!(
        v0.instructions[0].data,
        ComputeBudgetInstruction::set_compute_unit_limit(register_device_compute_unit_limit(bump))
            .data
    );

    let (status, body) = sponsor.submit(&device, &signed_by(&wallet, &bytes)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let account = device_account(&device.key()).await.expect("registered");
    assert_eq!(account.owner, BUCKSPAY_ID);
    assert_eq!(account.data[8..40], wallet.pubkey().to_bytes());
    assert_eq!(balance(&wallet.pubkey()).await, 0);
    assert_eq!(before - balance(&sponsor.fee_payer).await, RENT + 3 * 5_000);

    // A replay finds nothing to sign, and the key cannot be prepared again.
    let (status, _) = sponsor.submit(&device, &signed_by(&wallet, &bytes)).await;
    assert_eq!(status, StatusCode::GONE);
    let (status, _) = sponsor
        .post("/v1/registrations", &device.request(&wallet.pubkey()))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn checks_the_device_binding_before_reading_solana() {
    let sponsor = Sponsor::on(
        NOWHERE,
        Keypair::new(),
        Limits::new(caps()),
        ClientAddress::Peer,
    );
    let wallet = Keypair::new().pubkey();
    let device = Device::random();

    let mut other_wallet = device.request(&wallet);
    other_wallet["signature"] = json!(hex::encode(device.sign(&Keypair::new().pubkey())));
    let mut other_key = device.request(&wallet);
    other_key["key"] = json!(hex::encode(Device::random().key()));
    let mut high_s = device.request(&wallet);
    let low = P256Signature::from_slice(&device.sign(&wallet)).unwrap();
    let (r, s) = low.split_scalars();
    let high: [u8; 64] = P256Signature::from_scalars(r.to_bytes(), (-*s).to_bytes())
        .unwrap()
        .to_bytes()
        .into();
    high_s["signature"] = json!(hex::encode(high));
    let mut uncompressed = device.request(&wallet);
    uncompressed["key"] = json!(format!("04{}", &uncompressed["key"].as_str().unwrap()[2..]));

    for (name, body) in [
        ("binding for another wallet", other_wallet),
        ("another key", other_key),
        ("high S", high_s),
        ("not a device key", uncompressed),
        ("the gateway as wallet", device.request(&sponsor.fee_payer)),
    ] {
        let (status, _) = sponsor.post("/v1/registrations", &body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{name}");
    }
    // A valid binding is what reaches Solana.
    let (status, _) = sponsor
        .post("/v1/registrations", &device.request(&wallet))
        .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn a_pending_key_is_replaced_by_its_wallet_only() {
    let sponsor = Sponsor::new(caps()).await;
    let (wallet, other) = (Keypair::new(), Keypair::new());
    let device = Device::random();
    sponsor.prepare(&device, &wallet.pubkey()).await;
    let (status, _) = sponsor
        .post("/v1/registrations", &device.request(&other.pubkey()))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let again = message_bytes(&sponsor.prepare(&device, &wallet.pubkey()).await);
    let (status, body) = sponsor.submit(&device, &signed_by(&wallet, &again)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(device_account(&device.key()).await.is_some());
}

#[tokio::test]
async fn signs_nothing_but_the_prepared_message() {
    let sponsor = Sponsor::new(caps()).await;
    let wallet = Keypair::new();
    let device = Device::random();
    let prepared = sponsor.prepare(&device, &wallet.pubkey()).await;
    let bytes = message_bytes(&prepared);

    // Every single-byte change, signed by the wallet, is refused and leaves the entry in place.
    for at in 0..bytes.len() {
        let mut changed = bytes.clone();
        changed[at] ^= 1;
        let (status, _) = sponsor.submit(&device, &signed_by(&wallet, &changed)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "byte {at}");
    }

    // The registration's own blockhash and fee payer, with a transfer out of the wallet.
    let transfer = Instruction {
        program_id: Pubkey::default(),
        accounts: vec![
            AccountMeta::new(wallet.pubkey(), true),
            AccountMeta::new(Pubkey::new_unique(), false),
        ],
        data: vec![2, 0, 0, 0, 0, 202, 154, 59, 0, 0, 0, 0],
    };
    let injected = message::compile(
        &sponsor.fee_payer,
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(40_000),
            transfer,
        ],
        prepared.blockhash.parse().unwrap(),
    )
    .serialize();
    let (status, _) = sponsor
        .submit(&device, &signed_by(&wallet, &injected))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Another key's signature, no signature, or a third signature.
    let stranger = Keypair::new();
    for (name, wire) in [
        ("someone else's signature", signed_by(&stranger, &bytes)),
        (
            "no wallet signature",
            wire(&[Signature::default(); 2], &bytes),
        ),
        (
            "three signatures",
            wire(
                &[
                    Signature::default(),
                    wallet.sign_message(&bytes),
                    Signature::default(),
                ],
                &bytes,
            ),
        ),
    ] {
        let (status, _) = sponsor.submit(&device, &wire).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{name}");
    }
    assert!(device_account_now(&device.key()).await.is_none());

    // None of it cancelled the prepared registration.
    let (status, body) = sponsor.submit(&device, &signed_by(&wallet, &bytes)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(device_account(&device.key()).await.is_some());
}

async fn device_account_now(key: &[u8; 33]) -> Option<solana_account::Account> {
    let (address, _) = find_device_pda(key);
    rpc(&cluster().url)
        .get_account_with_commitment(&address, CommitmentConfig::processed())
        .await
        .unwrap()
        .value
}

/// The wallet registers the key itself between prepare and submit: the gateway's preflight
/// simulation fails, nothing is sent and nothing is counted.
#[tokio::test]
async fn a_failed_preflight_is_reported_and_not_counted() {
    let sponsor = Sponsor::new(Caps {
        outstanding: 1,
        ..caps()
    })
    .await;
    let wallet = funded(100_000_000).await;
    let device = Device::random();
    let bytes = message_bytes(&sponsor.prepare(&device, &wallet.pubkey()).await);

    let (address, _) = find_device_pda(&device.key());
    let rpc = rpc(&cluster().url);
    let blockhash = rpc.get_latest_blockhash().await.unwrap();
    let self_paid = Transaction::new_signed_with_payer(
        &[
            new_secp256r1_instruction_with_signature(
                &device.envelope(&wallet.pubkey()),
                &device.sign(&wallet.pubkey()),
                &device.key(),
            ),
            RegisterDeviceBuilder::new()
                .wallet(wallet.pubkey())
                .payer(wallet.pubkey())
                .device(address)
                .key(device.key())
                .instruction(),
        ],
        Some(&wallet.pubkey()),
        &[&wallet],
        blockhash,
    );
    rpc.send_and_confirm_transaction(&self_paid).await.unwrap();

    let before = balance(&sponsor.fee_payer).await;
    let (status, body) = sponsor.submit(&device, &signed_by(&wallet, &bytes)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    // The gateway's own words, never the RPC's.
    assert_eq!(
        body,
        json!({ "error": "Solana refused the registration in its preflight; nothing was sent" })
    );
    assert_eq!(balance(&sponsor.fee_payer).await, before);
    assert_eq!(sponsor.sponsorship("198.51.100.1:1").await, StatusCode::OK);
}

#[tokio::test]
async fn limits_requests_before_reading_them() {
    let sponsor = Sponsor::on(
        NOWHERE,
        Keypair::new(),
        Limits::new(Caps {
            requests_per_minute: NonZeroU32::new(2).unwrap(),
            ..caps()
        }),
        ClientAddress::Peer,
    );
    for _ in 0..2 {
        let (status, _) = sponsor
            .post_from("203.0.113.7:1", "/v1/registrations", "{".into())
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    // Same /24: refused before the body is parsed.
    let (status, _) = sponsor
        .post_from("203.0.113.99:1", "/v1/registrations", "{".into())
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let (status, _) = sponsor
        .post_from(
            "198.51.100.1:1",
            "/v1/registrations/submit",
            "x".repeat(10_000),
        )
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}

/// Sends a prepared and signed registration from `peer`, and returns the status of the step that
/// stopped it, or of the submission.
async fn register_from(sponsor: &Sponsor, peer: &str) -> StatusCode {
    register_across(sponsor, peer, peer).await
}

/// Prepares a registration from `preparer` and submits it from `submitter`.
async fn register_across(sponsor: &Sponsor, preparer: &str, submitter: &str) -> StatusCode {
    let wallet = Keypair::new();
    let device = Device::random();
    let (status, body) = sponsor
        .post_from(
            preparer,
            "/v1/registrations",
            device.request(&wallet.pubkey()).to_string(),
        )
        .await;
    if status != StatusCode::OK {
        return status;
    }
    let prepared: PrepareResponse = serde_json::from_value(body).unwrap();
    let bytes = message_bytes(&prepared);
    let body = json!({ "key": hex::encode(device.key()), "transaction": BASE64_STANDARD.encode(signed_by(&wallet, &bytes)) });
    sponsor
        .post_from(submitter, "/v1/registrations/submit", body.to_string())
        .await
        .0
}

/// Prepares a registration from `peer` and returns its status, without submitting it.
async fn prepare_from(sponsor: &Sponsor, peer: &str) -> StatusCode {
    let request = Device::random().request(&Keypair::new().pubkey());
    sponsor
        .post_from(peer, "/v1/registrations", request.to_string())
        .await
        .0
}

#[tokio::test]
async fn caps_sponsorships_per_network_and_in_total() {
    let sponsor = Sponsor::new(Caps {
        per_prefix: 1,
        outstanding: 2,
        ..caps()
    })
    .await;
    assert_eq!(sponsor.sponsorship("203.0.113.7:1").await, StatusCode::OK);
    assert_eq!(
        register_from(&sponsor, "203.0.113.7:1").await,
        StatusCode::OK
    );
    assert_eq!(
        sponsor.sponsorship("203.0.113.9:1").await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        register_from(&sponsor, "203.0.113.8:1").await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        register_from(&sponsor, "[2001:db8::1]:1").await,
        StatusCode::OK
    );
    assert_eq!(
        register_from(&sponsor, "198.51.100.1:1").await,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        sponsor.sponsorship("198.51.100.1:1").await,
        StatusCode::SERVICE_UNAVAILABLE
    );
}

/// The caps count registrations from prepare on, and charge the network that prepared them:
/// submitting from elsewhere, or preparing several before submitting any, escapes nothing.
#[tokio::test]
async fn charges_the_network_that_prepared() {
    let sponsor = Sponsor::new(Caps {
        per_prefix: 1,
        ..caps()
    })
    .await;
    assert_eq!(
        register_across(&sponsor, "203.0.113.7:1", "198.51.100.1:1").await,
        StatusCode::OK
    );
    assert_eq!(
        sponsor.sponsorship("203.0.113.8:1").await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(sponsor.sponsorship("198.51.100.1:1").await, StatusCode::OK);
    assert_eq!(prepare_from(&sponsor, "192.0.2.1:1").await, StatusCode::OK);
    assert_eq!(
        prepare_from(&sponsor, "192.0.2.2:1").await,
        StatusCode::TOO_MANY_REQUESTS
    );
}

/// Re-preparing a pending registration from a network the caps refuse leaves the pending one in
/// place: whoever holds a binding cannot cancel the wallet's registration by being refused.
#[tokio::test]
async fn a_refused_prepare_keeps_the_pending_one() {
    let sponsor = Sponsor::new(Caps {
        per_prefix: 1,
        ..caps()
    })
    .await;
    assert_eq!(
        register_from(&sponsor, "198.51.100.1:1").await,
        StatusCode::OK
    );
    let wallet = Keypair::new();
    let device = Device::random();
    let bytes = message_bytes(&sponsor.prepare(&device, &wallet.pubkey()).await);
    let (status, _) = sponsor
        .post_from(
            "198.51.100.2:1",
            "/v1/registrations",
            device.request(&wallet.pubkey()).to_string(),
        )
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let (status, body) = sponsor.submit(&device, &signed_by(&wallet, &bytes)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/// A TCP relay to `target` that can be cut, as a network failure would, with every connection
/// through it.
async fn relay(target: &str) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let target = target.trim_start_matches("http://").to_owned();
    let relay = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            let (mut inbound, _) = listener.accept().await.unwrap();
            let target = target.clone();
            connections.spawn(async move {
                if let Ok(mut outbound) = tokio::net::TcpStream::connect(target).await {
                    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                }
            });
        }
    });
    (url, relay)
}

/// A submission whose outcome Solana never reported is counted: it may still land.
#[tokio::test]
async fn counts_a_submission_whose_outcome_is_unknown() {
    let (url, relay) = relay(&cluster().url).await;
    let sponsor = Sponsor::on(
        &url,
        funded(1_000_000_000).await,
        Limits::new(Caps {
            per_prefix: 1,
            ..caps()
        }),
        ClientAddress::Peer,
    );
    let wallet = Keypair::new();
    let device = Device::random();
    let bytes = message_bytes(&sponsor.prepare(&device, &wallet.pubkey()).await);
    relay.abort();
    let _ = relay.await;
    let (status, _) = sponsor.submit(&device, &signed_by(&wallet, &bytes)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(
        sponsor.sponsorship("203.0.113.8:1").await,
        StatusCode::TOO_MANY_REQUESTS
    );
}

/// Concurrent prepares cannot all pass the caps before any of them counts.
#[tokio::test]
async fn concurrent_prepares_stay_within_the_caps() {
    let sponsor = Sponsor::new(Caps {
        outstanding: 2,
        ..caps()
    })
    .await;
    let statuses = tokio::join!(
        prepare_from(&sponsor, "203.0.113.1:1"),
        prepare_from(&sponsor, "198.51.100.1:1"),
        prepare_from(&sponsor, "192.0.2.1:1"),
        prepare_from(&sponsor, "[2001:db8::1]:1"),
    );
    let statuses = [statuses.0, statuses.1, statuses.2, statuses.3];
    assert_eq!(statuses.iter().filter(|s| **s == StatusCode::OK).count(), 2);
    assert_eq!(
        statuses
            .iter()
            .filter(|s| **s == StatusCode::SERVICE_UNAVAILABLE)
            .count(),
        2
    );
    // One network may prepare `preparing_per_prefix` at once.
    let busy = Sponsor::new(Caps {
        preparing_per_prefix: 2,
        ..caps()
    })
    .await;
    let statuses = tokio::join!(
        prepare_from(&busy, "203.0.113.1:1"),
        prepare_from(&busy, "203.0.113.2:1"),
        prepare_from(&busy, "203.0.113.3:1"),
    );
    let mut statuses = [statuses.0, statuses.1, statuses.2];
    statuses.sort();
    assert_eq!(
        statuses,
        [
            StatusCode::OK,
            StatusCode::OK,
            StatusCode::TOO_MANY_REQUESTS
        ]
    );
}

/// Prepared registrations that were never sent stop counting once they expire, whichever request
/// comes next.
#[tokio::test]
async fn expired_prepares_release_the_caps() {
    let caps = Caps {
        outstanding: 2,
        ..caps()
    };
    let settings = Settings {
        pending_ttl: Duration::from_secs(2),
        ..settings()
    };
    let sponsor = Sponsor::with_settings(
        &cluster().url,
        funded(1_000_000_000).await,
        Limits::new(caps),
        ClientAddress::Peer,
        settings,
    );
    assert_eq!(
        prepare_from(&sponsor, "203.0.113.1:1").await,
        StatusCode::OK
    );
    assert_eq!(
        prepare_from(&sponsor, "198.51.100.1:1").await,
        StatusCode::OK
    );
    assert_eq!(
        sponsor.sponsorship("192.0.2.1:1").await,
        StatusCode::SERVICE_UNAVAILABLE
    );
    tokio::time::sleep(Duration::from_millis(2_500)).await;
    assert_eq!(sponsor.sponsorship("192.0.2.1:1").await, StatusCode::OK);
}

/// A fee payer that cannot pay is refused at prepare, and the app's wallet pays instead.
#[tokio::test]
async fn refuses_to_prepare_when_the_fee_payer_cannot_pay() {
    let sponsor = Sponsor::on(
        &cluster().url,
        Keypair::new(),
        Limits::new(caps()),
        ClientAddress::Peer,
    );
    assert_eq!(
        prepare_from(&sponsor, "203.0.113.7:1").await,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(sponsor.sponsorship("203.0.113.7:1").await, StatusCode::OK);
}

/// A slow client holds a request no longer than the body deadline, and the gateway serves at most
/// `IN_FLIGHT` requests at once: one more is refused at once instead of waiting.
#[tokio::test]
async fn bounds_slow_requests() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let sponsor = Sponsor::on(
        NOWHERE,
        Keypair::new(),
        Limits::new(caps()),
        ClientAddress::Peer,
    );
    tokio::spawn(
        axum::serve(
            listener,
            sponsor
                .app
                .into_make_service_with_connect_info::<SocketAddr>(),
        )
        .into_future(),
    );
    let started = Instant::now();
    let mut slow = Vec::new();
    for _ in 0..IN_FLIGHT {
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        // A body of 100 bytes, of which only the first arrives.
        stream
            .write_all(b"POST /v1/registrations HTTP/1.1\r\nHost: gateway\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{")
            .await
            .unwrap();
        slow.push(stream);
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let mut one_more = tokio::net::TcpStream::connect(address).await.unwrap();
    one_more
        .write_all(b"POST /v1/registrations HTTP/1.1\r\nHost: gateway\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
        .await
        .unwrap();
    let mut refused = String::new();
    one_more.read_to_string(&mut refused).await.unwrap();
    assert!(refused.starts_with("HTTP/1.1 503"), "{refused}");
    assert!(
        refused.ends_with(r#"{"error":"the gateway is busy"}"#),
        "{refused}"
    );

    // One byte a second keeps a body coming, and the deadline still ends its request.
    let stream = &mut slow[0];
    let mut buffer = [0; 1024];
    let read = loop {
        tokio::select! {
            read = stream.read(&mut buffer) => break read.unwrap(),
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                stream.write_all(b" ").await.unwrap();
            }
        }
        assert!(started.elapsed() < BODY_DEADLINE + Duration::from_secs(5));
    };
    let response = String::from_utf8_lossy(&buffer[..read]);
    assert!(started.elapsed() >= BODY_DEADLINE, "{response}");
    assert!(response.starts_with("HTTP/1.1 4"), "{response}");
}

/// A restarted gateway reads the counts back: the caps still hold.
#[tokio::test]
async fn keeps_the_caps_across_a_restart() {
    let path = Path::new(env!("CARGO_TARGET_TMPDIR")).join("restart-sponsorships.json");
    let _ = fs::remove_file(&path);
    let caps = Caps {
        per_prefix: 1,
        ..caps()
    };
    let sponsor = Sponsor::with_limits(Limits::open(caps, &path).unwrap()).await;
    assert_eq!(
        register_from(&sponsor, "203.0.113.7:1").await,
        StatusCode::OK
    );
    drop(sponsor);

    let restarted = Sponsor::with_limits(Limits::open(caps, &path).unwrap()).await;
    assert_eq!(
        restarted.sponsorship("203.0.113.8:1").await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        restarted.sponsorship("198.51.100.1:1").await,
        StatusCode::OK
    );
}

/// Behind the reverse proxy the client's address is the proxy's `X-Real-IP`, and only that:
/// whatever the client puts in `X-Forwarded-For` changes nothing.
#[tokio::test]
async fn behind_the_proxy_limits_the_address_the_proxy_saw() {
    let sponsor = Sponsor::on(
        NOWHERE,
        Keypair::new(),
        Limits::new(Caps {
            requests_per_minute: NonZeroU32::new(1).unwrap(),
            ..caps()
        }),
        ClientAddress::Header("x-real-ip".parse().unwrap()),
    );
    let request = |real: Option<&str>, forwarded: &str| {
        let mut request =
            Request::get("/v1/registrations/sponsorship").header("x-forwarded-for", forwarded);
        if let Some(real) = real {
            request = request.header("x-real-ip", real);
        }
        request.body(Body::empty()).unwrap()
    };
    let peer = "127.0.0.1:1";
    assert_eq!(
        sponsor
            .send(peer, request(Some("203.0.113.7"), "1.1.1.1"))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        sponsor
            .send(peer, request(Some("203.0.113.8"), "2.2.2.2"))
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        sponsor
            .send(peer, request(Some("198.51.100.1"), "203.0.113.7"))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        sponsor.send(peer, request(None, "192.0.2.1")).await.0,
        StatusCode::BAD_REQUEST
    );
}

/// The gateway serves a Unix socket only its owner and group can open.
#[tokio::test]
async fn serves_a_unix_socket() {
    use std::os::unix::fs::PermissionsExt;
    let path = Path::new(env!("CARGO_TARGET_TMPDIR")).join("gateway.sock");
    let listener = bind_unix(&path).unwrap();
    let sponsor = Sponsor::on(
        NOWHERE,
        Keypair::new(),
        Limits::new(caps()),
        ClientAddress::Header("x-real-ip".parse().unwrap()),
    );
    tokio::spawn(axum::serve(listener, sponsor.app).into_future());
    let mut stream = tokio::net::UnixStream::connect(&path).await.unwrap();
    stream
        .write_all(b"GET /v1/registrations/sponsorship HTTP/1.1\r\nHost: gateway\r\nX-Real-IP: 203.0.113.7\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
    assert!(response.ends_with(r#"{"available":true}"#), "{response}");
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o660
    );
}

/// What the gateway logs while it sponsors a registration: the signature, and neither the client's
/// address, its network, the wallet, the device key nor the request.
#[tokio::test]
async fn logs_neither_addresses_nor_keys() {
    #[derive(Clone, Default)]
    struct Captured(std::sync::Arc<Mutex<Vec<u8>>>);
    impl Write for Captured {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let captured = Captured::default();
    let writer = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    // The process's subscriber: a scoped one misses events whose interest another test thread
    // cached without it. It also takes the other tests' lines, which must not leak either.
    tracing::subscriber::set_global_default(subscriber).unwrap();

    let sponsor = Sponsor::new(caps()).await;
    let wallet = Keypair::new();
    let device = Device::random();
    let peer = "203.0.113.77:4242";
    let (_, body) = sponsor
        .post_from(
            peer,
            "/v1/registrations",
            device.request(&wallet.pubkey()).to_string(),
        )
        .await;
    let prepared: PrepareResponse = serde_json::from_value(body).unwrap();
    let submit = json!({ "key": hex::encode(device.key()), "transaction": BASE64_STANDARD.encode(signed_by(&wallet, &message_bytes(&prepared))) });
    let (status, sent) = sponsor
        .post_from(peer, "/v1/registrations/submit", submit.to_string())
        .await;
    assert_eq!(status, StatusCode::OK);

    // An RPC's errors carry its URL, and a provider's URL its API key: neither is logged or
    // returned.
    let keyed = Sponsor::on(
        "http://127.0.0.1:9/?api-key=SECRET-RPC-KEY",
        Keypair::new(),
        Limits::new(caps()),
        ClientAddress::Peer,
    );
    let (status, body) = keyed
        .post_from(
            peer,
            "/v1/registrations",
            device.request(&Keypair::new().pubkey()).to_string(),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body, json!({ "error": "Solana is unreachable" }));

    let logs = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    assert!(logs.contains("sponsored registration sent"), "{logs}");
    assert!(logs.contains("Solana is unreachable"), "{logs}");
    assert!(logs.contains(sent["signature"].as_str().unwrap()));
    for secret in [
        "203.0.113.77".to_owned(),
        "203.0.113.0".to_owned(),
        wallet.pubkey().to_string(),
        hex::encode(device.key()),
        prepared.transaction.clone(),
        "SECRET-RPC-KEY".to_owned(),
        "127.0.0.1:9".to_owned(),
    ] {
        assert!(!logs.contains(&secret), "{secret} in {logs}");
    }
}

#[tokio::test]
async fn publishes_the_hpke_configuration() {
    let sponsor = Sponsor::on(
        NOWHERE,
        Keypair::new(),
        Limits::new(caps()),
        ClientAddress::Peer,
    );
    let request = Request::get("/v1/hpke-config").body(Body::empty()).unwrap();
    let (status, body) = sponsor.send("203.0.113.7:1", request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "keys": hpke().published() }));
}

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/registration.json"
);

/// A sponsored registration of fixed keys, for the app's builder, which must produce these bytes.
#[test]
fn registration_fixture_is_current() {
    let wallet = Keypair::new_from_array([0x57; 32]).pubkey();
    let fee_payer = Keypair::new_from_array([0x9a; 32]).pubkey();
    let device = Device::new(9);
    let blockhash = Hash::new_from_array([0x42; 32]);
    let message = registration_message(
        &fee_payer,
        &wallet,
        &device.key(),
        &device.sign(&wallet),
        &device.envelope(&wallet),
        12_345,
        blockhash,
    );
    let mut json = serde_json::to_string_pretty(&json!({
        "wallet": wallet.to_string(),
        "feePayer": fee_payer.to_string(),
        "device": hex::encode(device.key()),
        "signature": hex::encode(device.sign(&wallet)),
        "envelope": hex::encode(device.envelope(&wallet)),
        "blockhash": blockhash.to_string(),
        "computeUnitPrice": 12_345,
        "message": BASE64_STANDARD.encode(message.serialize()),
    }))
    .unwrap();
    json.push('\n');
    if std::env::var_os("WRITE_FIXTURE").is_some() {
        fs::write(FIXTURE, &json).unwrap();
    }
    let committed = fs::read_to_string(FIXTURE).unwrap_or_default();
    assert_eq!(
        committed, json,
        "run: WRITE_FIXTURE=1 cargo test --test registration registration_fixture"
    );
}
