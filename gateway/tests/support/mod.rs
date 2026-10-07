//! What the gateway's tests against a validator share: one `solana-test-validator` for the whole
//! test binary with the short-windows build of the program at its own id and the token programs
//! cloned from devnet (read only), a mint, wallets with tokens and no SOL, device keys, and a
//! gateway to talk to.
#![allow(dead_code, unused_imports)]
use axum::{
    Router,
    body::Body,
    extract::connect_info::MockConnectInfo,
    http::{Request, StatusCode, header},
};
use base64::{Engine, prelude::BASE64_STANDARD};
use buckspay_client::Program;
use buckspay_gateway::{
    chain::{self, Rents},
    float::{Caps as FloatCaps, SettlementLimits},
    hpke::HpkeKeys,
    jobs::Jobs,
    limits::RequestLimits,
    relay::Relay,
    server::{ClientAddress, Gateway, Limits, Settings, router},
    sponsor::{Caps, Escalation, FeeMode, SponsorLimits},
    sponsored::{CONFIRM_TIMEOUT, PENDING_TTL},
};
use buckspay_protocol::{
    cluster::DEVNET_GENESIS_HASH,
    device::{device_binding_envelope, device_rotation_envelope},
    hash::{domain, purpose},
    lock::Windows,
    profile::SHORT_PROGRAM_ID,
};
use http_body_util::BodyExt;
use p256::ecdsa::{Signature as P256Signature, SigningKey, signature::Signer as _};
use serde_json::{Value, json};
use solana_account::Account;
use solana_commitment_config::CommitmentConfig;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::{
    net::{SocketAddr, TcpListener},
    num::NonZeroU32,
    path::Path,
    process::{Child, Command, Stdio},
    str::FromStr,
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::Duration,
};
use tower::ServiceExt;

mod notes;
pub mod zk;
pub use notes::*;

const SHORT_PROGRAM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../anchor/target/deploy-short/buckspay.so"
);
/// Nothing listens here: any read of Solana fails, and the gateway answers `502`.
pub const NOWHERE: &str = "http://127.0.0.1:9";
pub const PEER: &str = "203.0.113.7:4000";

pub fn program() -> Program {
    Program::new(Pubkey::from_str(SHORT_PROGRAM_ID).unwrap())
}

pub struct Cluster {
    pub url: String,
    pub mint: Pubkey,
    payer: Keypair,
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// One validator for the whole test binary, on ports nobody else uses. It runs under a shell that
/// stops it once its stdin closes, which happens when the test process exits, however it exits.
pub fn cluster() -> &'static Cluster {
    static CLUSTER: OnceLock<(Cluster, Mutex<Child>)> = OnceLock::new();
    let (cluster, _) = CLUSTER.get_or_init(|| {
        // The blocking RPC client starts a runtime of its own, which a test's runtime forbids.
        thread::spawn(start).join().unwrap()
    });
    cluster
}

fn start() -> (Cluster, Mutex<Child>) {
    {
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
             --url devnet --clone-upgradeable-program {token} \
             --clone-upgradeable-program {token_2022} \
             --upgradeable-program {program} {SHORT_PROGRAM} {authority} > {ledger}.log 2>&1 & \
             validator=$!; read -r _; kill $validator",
            ledger = ledger.display(),
            faucet = free_port(),
            gossip = free_port(),
            token = chain::TOKEN_PROGRAM,
            token_2022 = chain::TOKEN_2022_PROGRAM,
            program = SHORT_PROGRAM_ID,
            authority = zk::admin().pubkey(),
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
                let program = Pubkey::from_str(SHORT_PROGRAM_ID).unwrap();
                (0..240).any(|_| {
                    thread::sleep(Duration::from_millis(500));
                    [program, chain::TOKEN_PROGRAM, chain::TOKEN_2022_PROGRAM]
                        .iter()
                        .all(|id| rpc.get_account(id).is_ok_and(|account| account.executable))
                })
            }
        });
        assert!(ready.join().unwrap(), "the validator did not start");
        let payer = Keypair::new();
        let mint = Keypair::new_from_array([0x4d; 32]);
        let rpc = solana_rpc_client::rpc_client::RpcClient::new_with_commitment(
            url.clone(),
            CommitmentConfig::confirmed(),
        );
        let signature = rpc
            .request_airdrop(&payer.pubkey(), 1_000_000_000_000)
            .unwrap();
        while !rpc.confirm_transaction(&signature).unwrap() {
            thread::sleep(Duration::from_millis(250));
        }
        let rent = rpc.get_minimum_balance_for_rent_exemption(82).unwrap();
        let mut initialize = vec![20, 6];
        initialize.extend_from_slice(payer.pubkey().as_ref());
        initialize.push(0);
        let transaction = Transaction::new_signed_with_payer(
            &[
                create_account(
                    &payer.pubkey(),
                    &mint.pubkey(),
                    rent,
                    82,
                    &chain::TOKEN_PROGRAM,
                ),
                Instruction {
                    program_id: chain::TOKEN_PROGRAM,
                    accounts: vec![AccountMeta::new(mint.pubkey(), false)],
                    data: initialize,
                },
            ],
            Some(&payer.pubkey()),
            &[&payer, &mint],
            rpc.get_latest_blockhash().unwrap(),
        );
        rpc.send_and_confirm_transaction(&transaction).unwrap();
        (
            Cluster {
                url,
                mint: mint.pubkey(),
                payer,
            },
            Mutex::new(child),
        )
    }
}

fn create_account(
    from: &Pubkey,
    to: &Pubkey,
    lamports: u64,
    space: u64,
    owner: &Pubkey,
) -> Instruction {
    let mut data = vec![0, 0, 0, 0];
    data.extend_from_slice(&lamports.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(owner.as_ref());
    Instruction {
        program_id: Pubkey::default(),
        accounts: vec![AccountMeta::new(*from, true), AccountMeta::new(*to, true)],
        data,
    }
}

pub fn rpc(url: &str) -> RpcClient {
    RpcClient::new_with_commitment(url.to_owned(), CommitmentConfig::confirmed())
}

/// A new account with `lamports` from the validator's faucet.
pub async fn funded(lamports: u64) -> Keypair {
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

pub async fn balance(account: &Pubkey) -> u64 {
    rpc(&cluster().url).get_balance(account).await.unwrap()
}

pub async fn account(address: &Pubkey) -> Option<Account> {
    rpc(&cluster().url)
        .get_account_with_commitment(address, CommitmentConfig::confirmed())
        .await
        .unwrap()
        .value
}

pub async fn token_balance(account: &Pubkey) -> u64 {
    chain::TokenAccount::parse(&self::account(account).await.unwrap().data)
        .unwrap()
        .amount
}

/// Sends `instructions`, paid and signed by the test payer and `signers`.
pub async fn send(instructions: &[Instruction], signers: &[&Keypair]) {
    let rpc = rpc(&cluster().url);
    let payer = &cluster().payer;
    let mut all = vec![payer];
    all.extend(signers);
    let transaction = Transaction::new_signed_with_payer(
        instructions,
        Some(&payer.pubkey()),
        &all,
        rpc.get_latest_blockhash().await.unwrap(),
    );
    rpc.send_and_confirm_transaction(&transaction)
        .await
        .unwrap();
}

/// A token account of the mint owned by `owner`.
pub async fn token_account(owner: &Pubkey, tokens: u64) -> Pubkey {
    let account = Keypair::new();
    let rent = rpc(&cluster().url)
        .get_minimum_balance_for_rent_exemption(165)
        .await
        .unwrap();
    let mut initialize = vec![18];
    initialize.extend_from_slice(owner.as_ref());
    let mut mint_to = vec![7];
    mint_to.extend_from_slice(&tokens.to_le_bytes());
    let mut instructions = vec![
        create_account(
            &cluster().payer.pubkey(),
            &account.pubkey(),
            rent,
            165,
            &chain::TOKEN_PROGRAM,
        ),
        Instruction {
            program_id: chain::TOKEN_PROGRAM,
            accounts: vec![
                AccountMeta::new(account.pubkey(), false),
                AccountMeta::new_readonly(cluster().mint, false),
            ],
            data: initialize,
        },
    ];
    if tokens > 0 {
        instructions.push(Instruction {
            program_id: chain::TOKEN_PROGRAM,
            accounts: vec![
                AccountMeta::new(cluster().mint, false),
                AccountMeta::new(account.pubkey(), false),
                AccountMeta::new_readonly(cluster().payer.pubkey(), true),
            ],
            data: mint_to,
        });
    }
    send(&instructions, &[&account]).await;
    account.pubkey()
}

/// Moves `amount` out of `from`, owned by `owner`, to another token account.
pub async fn move_tokens(owner: &Keypair, from: &Pubkey, amount: u64) {
    let to = token_account(&Keypair::new().pubkey(), 0).await;
    let mut data = vec![3];
    data.extend_from_slice(&amount.to_le_bytes());
    send(
        &[Instruction {
            program_id: chain::TOKEN_PROGRAM,
            accounts: vec![
                AccountMeta::new(*from, false),
                AccountMeta::new(to, false),
                AccountMeta::new_readonly(owner.pubkey(), true),
            ],
            data,
        }],
        &[owner],
    )
    .await;
}

/// A wallet with no SOL and `tokens` of the mint.
pub struct Wallet {
    pub keypair: Keypair,
    pub token: Pubkey,
}

pub async fn wallet(tokens: u64) -> Wallet {
    let keypair = Keypair::new();
    let token = token_account(&keypair.pubkey(), tokens).await;
    Wallet { keypair, token }
}

pub struct Device(pub SigningKey);

impl Device {
    pub fn new(seed: u8) -> Self {
        Self(SigningKey::from_slice(&[seed; 32]).unwrap())
    }

    pub fn random() -> Self {
        Self(SigningKey::from_slice(&Keypair::new().to_bytes()[..32]).unwrap())
    }

    pub fn key(&self) -> [u8; 33] {
        self.0
            .verifying_key()
            .to_sec1_point(true)
            .as_bytes()
            .try_into()
            .unwrap()
    }

    fn domain() -> [u8; 32] {
        domain(
            purpose::DEVICE,
            &DEVNET_GENESIS_HASH,
            &program().id().to_bytes(),
        )
    }

    pub fn binding_envelope(&self, wallet: &Pubkey) -> [u8; 96] {
        device_binding_envelope(&Self::domain(), &wallet.to_bytes(), &self.key()).unwrap()
    }

    pub fn sign(&self, envelope: &[u8; 96]) -> [u8; 64] {
        let signature: P256Signature = self.0.sign(envelope);
        signature.normalize_s().to_bytes().into()
    }

    pub fn sign_binding(&self, wallet: &Pubkey) -> [u8; 64] {
        self.sign(&self.binding_envelope(wallet))
    }

    pub fn rotation_envelope(&self, old: &Pubkey, new: &Pubkey, counter: u32) -> [u8; 96] {
        device_rotation_envelope(
            &Self::domain(),
            &old.to_bytes(),
            &new.to_bytes(),
            &self.key(),
            counter,
        )
        .unwrap()
    }

    pub fn sign_rotation(&self, old: &Pubkey, new: &Pubkey, counter: u32) -> [u8; 64] {
        self.sign(&self.rotation_envelope(old, new, counter))
    }

    pub fn onboard_request(
        &self,
        wallet: &Wallet,
        bond: u64,
        backing: u64,
        lock_until: u32,
    ) -> Value {
        json!({
            "wallet": wallet.keypair.pubkey().to_string(),
            "key": hex::encode(self.key()),
            "funder": wallet.token.to_string(),
            "bond": bond.to_string(),
            "backing": backing.to_string(),
            "lockUntil": lock_until,
            "signature": hex::encode(self.sign_binding(&wallet.keypair.pubkey())),
        })
    }

    pub fn lock_request(&self, wallet: &Wallet, bond: u64, backing: u64, lock_until: u32) -> Value {
        json!({
            "wallet": wallet.keypair.pubkey().to_string(),
            "key": hex::encode(self.key()),
            "funder": wallet.token.to_string(),
            "bond": bond.to_string(),
            "backing": backing.to_string(),
            "lockUntil": lock_until,
        })
    }
}

/// The chain's own clock, which is what a lock's window is measured against.
pub async fn chain_now() -> u32 {
    let clock = account(&chain::CLOCK_SYSVAR).await.unwrap();
    u32::try_from(chain::clock_unix(&clock.data).unwrap()).unwrap()
}

pub const MIN_FUNDING: u64 = 2_000_000;

/// Generous caps, with the escalation switched off so a test of another limit is not affected by it.
pub fn caps() -> Caps {
    Caps {
        cac_budget: 500_000_000,
        open_rent_cap: 600_000_000,
        daily_onboardings: 1_000,
        per_prefix_per_day: 1_000,
        per_prefix_per_30_days: 1_000,
        preparing_per_prefix: 1_000,
        escalation: Escalation {
            base_min_funding: MIN_FUNDING,
            steps: Vec::new(),
            fee_on_percent: 101,
            fee_off_percent: 101,
        },
    }
}

pub fn settings() -> Settings {
    Settings {
        program: program(),
        windows: Windows::SHORT,
        genesis_hash: DEVNET_GENESIS_HASH,
        mint: cluster().mint,
        max_priority_fee: 100_000,
        pending_ttl: PENDING_TTL,
        confirm_timeout: CONFIRM_TIMEOUT,
        max_lock_days: 45,
        fee_mode: FeeMode::Off,
        fee_token: None,
        sol_price_micro_usdc: None,
        held_keys: Vec::new(),
        claim_float_cap: 50_000_000,
    }
}

/// The pilot limits on settlements with the windows of the short profile and a janitor that does
/// not wait after a record is due.
pub fn float_caps() -> FloatCaps {
    let mut caps = FloatCaps::pilot(Windows::SHORT.record_ttl());
    caps.close_margin = 1;
    caps
}

pub fn hpke() -> HpkeKeys {
    HpkeKeys::from_secrets(&[[0x11; 32]]).unwrap()
}

/// The rents of the validator's cluster, as the gateway reads them at start.
pub async fn rents() -> Rents {
    let rpc = rpc(&cluster().url);
    let rent = |len: usize| {
        let rpc = &rpc;
        async move {
            rpc.get_minimum_balance_for_rent_exemption(len)
                .await
                .unwrap()
        }
    };
    Rents {
        device: rent(49).await,
        rotation: rent(77).await,
        lock: rent(62).await,
        ledger: rent(103).await,
        escrow: rent(165).await,
        record: rent(81).await,
        claim: rent(92).await,
    }
}

pub struct Sponsor {
    pub fee_payer: Pubkey,
    pub gateway: Arc<Gateway>,
    pub app: Router,
}

impl Sponsor {
    /// A gateway on the test validator with its own funded fee payer.
    pub async fn new(caps: Caps) -> Self {
        Self::with(
            &cluster().url,
            funded(1_000_000_000).await,
            SponsorLimits::new(caps),
            settings(),
            ClientAddress::Peer,
            rents().await,
        )
    }

    pub async fn with_limits(limits: Arc<SponsorLimits>, settings: Settings) -> Self {
        Self::with(
            &cluster().url,
            funded(1_000_000_000).await,
            limits,
            settings,
            ClientAddress::Peer,
            rents().await,
        )
    }

    /// A gateway whose RPC is `url`.
    pub fn with(
        url: &str,
        fee_payer: Keypair,
        limits: Arc<SponsorLimits>,
        settings: Settings,
        client: ClientAddress,
        rents: Rents,
    ) -> Self {
        Self::with_requests(url, fee_payer, limits, settings, client, rents, 1_000)
    }

    /// A gateway that serves each network `per_minute` requests a minute.
    pub fn with_requests(
        url: &str,
        fee_payer: Keypair,
        limits: Arc<SponsorLimits>,
        settings: Settings,
        client: ClientAddress,
        rents: Rents,
        per_minute: u32,
    ) -> Self {
        Self::with_float(
            url,
            fee_payer,
            limits,
            SettlementLimits::new(float_caps()),
            settings,
            client,
            rents,
            per_minute,
        )
    }

    /// A gateway with the given limits on the settlements it sponsors.
    #[allow(clippy::too_many_arguments)]
    pub fn with_float(
        url: &str,
        fee_payer: Keypair,
        limits: Arc<SponsorLimits>,
        float: Arc<SettlementLimits>,
        settings: Settings,
        client: ClientAddress,
        rents: Rents,
        per_minute: u32,
    ) -> Self {
        Self::on(
            rpc(url),
            fee_payer,
            limits,
            float,
            settings,
            client,
            rents,
            per_minute,
        )
    }

    /// A gateway that reads and sends through `rpc`.
    #[allow(clippy::too_many_arguments)]
    pub fn on(
        rpc: RpcClient,
        fee_payer: Keypair,
        limits: Arc<SponsorLimits>,
        float: Arc<SettlementLimits>,
        settings: Settings,
        client: ClientAddress,
        rents: Rents,
        per_minute: u32,
    ) -> Self {
        Self::on_jobs(
            rpc,
            fee_payer,
            limits,
            float,
            settings,
            client,
            rents,
            per_minute,
            Jobs::default(),
        )
    }

    /// A gateway that keeps its settlement jobs in `jobs`.
    #[allow(clippy::too_many_arguments)]
    pub fn on_jobs(
        rpc: RpcClient,
        fee_payer: Keypair,
        limits: Arc<SponsorLimits>,
        float: Arc<SettlementLimits>,
        settings: Settings,
        client: ClientAddress,
        rents: Rents,
        per_minute: u32,
        jobs: Jobs,
    ) -> Self {
        Self::on_relay(
            rpc,
            fee_payer,
            limits,
            float,
            settings,
            client,
            rents,
            per_minute,
            jobs,
            Relay::default(),
        )
    }

    /// A gateway that keeps its jobs in `jobs` and relays under `relay`.
    #[allow(clippy::too_many_arguments)]
    pub fn on_relay(
        rpc: RpcClient,
        fee_payer: Keypair,
        limits: Arc<SponsorLimits>,
        float: Arc<SettlementLimits>,
        settings: Settings,
        client: ClientAddress,
        rents: Rents,
        per_minute: u32,
        jobs: Jobs,
        relay: Relay,
    ) -> Self {
        let fee_payer_address = fee_payer.pubkey();
        let gateway = Arc::new(
            Gateway::new(
                rpc,
                fee_payer,
                settings,
                rents,
                Limits {
                    requests: RequestLimits::new(NonZeroU32::new(per_minute).unwrap()),
                    sponsor: limits,
                    settlements: float,
                },
                hpke(),
            )
            .with_jobs(jobs)
            .with_relay(relay),
        );
        Self {
            fee_payer: fee_payer_address,
            app: router(Arc::clone(&gateway), client),
            gateway,
        }
    }

    pub async fn send(&self, peer: &str, request: Request<Body>) -> (StatusCode, Value) {
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

    pub async fn post_from(&self, peer: &str, path: &str, body: String) -> (StatusCode, Value) {
        let request = Request::post(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap();
        self.send(peer, request).await
    }

    pub async fn post(&self, path: &str, body: &Value) -> (StatusCode, Value) {
        self.post_from(PEER, path, body.to_string()).await
    }

    pub async fn get(&self, peer: &str, path: &str) -> (StatusCode, Value) {
        self.send(peer, Request::get(path).body(Body::empty()).unwrap())
            .await
    }

    pub async fn quote(&self, peer: &str) -> Value {
        let (status, body) = self.get(peer, "/v1/onboarding/quote").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    /// Prepares through `path` and returns the answer.
    pub async fn prepare(&self, path: &str, body: &Value) -> Prepared {
        let (status, body) = self.post(path, body).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        Prepared::from(body)
    }

    pub async fn submit(&self, path: &str, key: &[u8; 33], wire: &[u8]) -> (StatusCode, Value) {
        self.submit_from(PEER, path, key, wire).await
    }

    pub async fn submit_from(
        &self,
        peer: &str,
        path: &str,
        key: &[u8; 33],
        wire: &[u8],
    ) -> (StatusCode, Value) {
        let body = json!({ "key": hex::encode(key), "transaction": BASE64_STANDARD.encode(wire) });
        self.post_from(peer, path, body.to_string()).await
    }
}

pub struct Prepared {
    pub body: Value,
    pub wire: Vec<u8>,
}

impl From<Value> for Prepared {
    fn from(body: Value) -> Self {
        let wire = BASE64_STANDARD
            .decode(body["transaction"].as_str().unwrap())
            .unwrap();
        assert_eq!(wire[0], 2);
        assert!(wire[1..129].iter().all(|byte| *byte == 0));
        Self { body, wire }
    }
}

impl Prepared {
    pub fn message(&self) -> &[u8] {
        &self.wire[129..]
    }

    /// The message signed by `wallet` as the second signer, the way the app returns it.
    pub fn signed_by(&self, wallet: &Keypair) -> Vec<u8> {
        wire(
            &[Signature::default(), wallet.sign_message(self.message())],
            self.message(),
        )
    }
}

/// `count ‖ signatures ‖ message`, the wire format of a transaction.
pub fn wire(signatures: &[Signature], message: &[u8]) -> Vec<u8> {
    let mut wire = vec![signatures.len() as u8];
    signatures
        .iter()
        .for_each(|signature| wire.extend_from_slice(signature.as_ref()));
    wire.extend_from_slice(message);
    wire
}

/// A wallet with `tokens` of a mint other than the gateway's.
pub async fn foreign_wallet(tokens: u64) -> Wallet {
    let mint = Keypair::new();
    let owner = Keypair::new();
    let rent = rpc(&cluster().url)
        .get_minimum_balance_for_rent_exemption(82)
        .await
        .unwrap();
    let mut initialize = vec![20, 6];
    initialize.extend_from_slice(cluster().payer.pubkey().as_ref());
    initialize.push(0);
    send(
        &[
            create_account(
                &cluster().payer.pubkey(),
                &mint.pubkey(),
                rent,
                82,
                &chain::TOKEN_PROGRAM,
            ),
            Instruction {
                program_id: chain::TOKEN_PROGRAM,
                accounts: vec![AccountMeta::new(mint.pubkey(), false)],
                data: initialize,
            },
        ],
        &[&mint],
    )
    .await;
    let token = Keypair::new();
    let rent = rpc(&cluster().url)
        .get_minimum_balance_for_rent_exemption(165)
        .await
        .unwrap();
    let mut initialize = vec![18];
    initialize.extend_from_slice(owner.pubkey().as_ref());
    let mut mint_to = vec![7];
    mint_to.extend_from_slice(&tokens.to_le_bytes());
    send(
        &[
            create_account(
                &cluster().payer.pubkey(),
                &token.pubkey(),
                rent,
                165,
                &chain::TOKEN_PROGRAM,
            ),
            Instruction {
                program_id: chain::TOKEN_PROGRAM,
                accounts: vec![
                    AccountMeta::new(token.pubkey(), false),
                    AccountMeta::new_readonly(mint.pubkey(), false),
                ],
                data: initialize,
            },
            Instruction {
                program_id: chain::TOKEN_PROGRAM,
                accounts: vec![
                    AccountMeta::new(mint.pubkey(), false),
                    AccountMeta::new(token.pubkey(), false),
                    AccountMeta::new_readonly(cluster().payer.pubkey(), true),
                ],
                data: mint_to,
            },
        ],
        &[&token],
    )
    .await;
    Wallet {
        keypair: owner,
        token: token.pubkey(),
    }
}

/// A TCP relay to `target` that can be cut, as a network failure would, with every connection
/// through it.
pub async fn relay(target: &str) -> (String, tokio::task::JoinHandle<()>) {
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

/// A wallet with `tokens` in its associated token account, the account a janitor releases to.
pub async fn associated_wallet(tokens: u64) -> Wallet {
    associated_wallet_of(&Keypair::new(), tokens).await
}

/// The same for a wallet that exists already.
pub async fn associated_wallet_of(keypair: &Keypair, tokens: u64) -> Wallet {
    let token =
        chain::associated_token_address(&keypair.pubkey(), &cluster().mint, &chain::TOKEN_PROGRAM);
    let payer = cluster().payer.pubkey();
    let mut instructions = vec![Instruction {
        program_id: chain::ASSOCIATED_TOKEN_PROGRAM,
        accounts: vec![
            AccountMeta::new(payer, true),
            AccountMeta::new(token, false),
            AccountMeta::new_readonly(keypair.pubkey(), false),
            AccountMeta::new_readonly(cluster().mint, false),
            AccountMeta::new_readonly(Pubkey::default(), false),
            AccountMeta::new_readonly(chain::TOKEN_PROGRAM, false),
        ],
        data: vec![1],
    }];
    if tokens > 0 {
        let mut mint_to = vec![7];
        mint_to.extend_from_slice(&tokens.to_le_bytes());
        instructions.push(Instruction {
            program_id: chain::TOKEN_PROGRAM,
            accounts: vec![
                AccountMeta::new(cluster().mint, false),
                AccountMeta::new(token, false),
                AccountMeta::new_readonly(payer, true),
            ],
            data: mint_to,
        });
    }
    send(&instructions, &[]).await;
    Wallet {
        keypair: keypair.insecure_clone(),
        token,
    }
}

/// Sends `instructions` paid and signed by `payer` alone.
pub async fn send_as(payer: &Keypair, instructions: &[Instruction]) {
    let rpc = rpc(&cluster().url);
    let transaction = Transaction::new_signed_with_payer(
        instructions,
        Some(&payer.pubkey()),
        &[payer],
        rpc.get_latest_blockhash().await.unwrap(),
    );
    rpc.send_and_confirm_transaction(&transaction)
        .await
        .unwrap();
}

/// The same as a transaction v1: the size of one holds what a legacy transaction cannot.
pub async fn send_v1_as(payer: &Keypair, instructions: &[Instruction]) {
    let rpc = rpc(&cluster().url);
    let config = solana_message::v1::TransactionConfig {
        priority_fee: Some(0),
        compute_unit_limit: Some(200_000),
        loaded_accounts_data_size_limit: Some(2 * 1_024 * 1_024),
        heap_size: None,
    };
    let message = solana_message::VersionedMessage::V1(
        solana_message::v1::Message::try_compile_with_config(
            &payer.pubkey(),
            instructions,
            rpc.get_latest_blockhash().await.unwrap(),
            config,
        )
        .unwrap(),
    );
    let transaction = solana_transaction::versioned::VersionedTransaction {
        signatures: vec![payer.sign_message(&message.serialize())],
        message,
    };
    rpc.send_and_confirm_transaction(&transaction)
        .await
        .unwrap();
}

/// Waits until the chain's own clock reaches `unix`.
pub async fn wait_for_chain(unix: u32) {
    while chain_now().await < unix {
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// A mint of `token_program` with 6 decimals, authority the test payer.
pub async fn mint_in(token_program: &Pubkey) -> Pubkey {
    let mint = Keypair::new();
    let rent = rpc(&cluster().url)
        .get_minimum_balance_for_rent_exemption(82)
        .await
        .unwrap();
    let mut initialize = vec![20, 6];
    initialize.extend_from_slice(cluster().payer.pubkey().as_ref());
    initialize.push(0);
    send(
        &[
            create_account(
                &cluster().payer.pubkey(),
                &mint.pubkey(),
                rent,
                82,
                token_program,
            ),
            Instruction {
                program_id: *token_program,
                accounts: vec![AccountMeta::new(mint.pubkey(), false)],
                data: initialize,
            },
        ],
        &[&mint],
    )
    .await;
    mint.pubkey()
}

/// A wallet with no SOL and `tokens` of `mint`, under `token_program`.
pub async fn wallet_in(token_program: &Pubkey, mint: &Pubkey, tokens: u64) -> Wallet {
    let keypair = Keypair::new();
    let account = Keypair::new();
    let rent = rpc(&cluster().url)
        .get_minimum_balance_for_rent_exemption(165)
        .await
        .unwrap();
    let mut initialize = vec![18];
    initialize.extend_from_slice(keypair.pubkey().as_ref());
    let mut mint_to = vec![7];
    mint_to.extend_from_slice(&tokens.to_le_bytes());
    send(
        &[
            create_account(
                &cluster().payer.pubkey(),
                &account.pubkey(),
                rent,
                165,
                token_program,
            ),
            Instruction {
                program_id: *token_program,
                accounts: vec![
                    AccountMeta::new(account.pubkey(), false),
                    AccountMeta::new_readonly(*mint, false),
                ],
                data: initialize,
            },
            Instruction {
                program_id: *token_program,
                accounts: vec![
                    AccountMeta::new(*mint, false),
                    AccountMeta::new(account.pubkey(), false),
                    AccountMeta::new_readonly(cluster().payer.pubkey(), true),
                ],
                data: mint_to,
            },
        ],
        &[&account],
    )
    .await;
    Wallet {
        keypair,
        token: account.pubkey(),
    }
}

/// The compute units the transaction `signature` consumed, from the validator.
pub async fn units_of(signature: &str) -> u64 {
    use solana_rpc_client_api::config::RpcTransactionConfig;
    use solana_transaction_status_client_types::UiTransactionEncoding;
    let fetched = rpc(&cluster().url)
        .get_transaction_with_config(
            &signature.parse().unwrap(),
            RpcTransactionConfig {
                encoding: Some(UiTransactionEncoding::Base64),
                commitment: Some(CommitmentConfig::confirmed()),
                max_supported_transaction_version: Some(1),
            },
        )
        .await
        .unwrap();
    Option::<u64>::from(fetched.transaction.meta.unwrap().compute_units_consumed).unwrap()
}

/// How many transactions touched `address` so far.
pub async fn transactions_of(address: &Pubkey) -> usize {
    rpc(&cluster().url)
        .get_signatures_for_address(address)
        .await
        .unwrap()
        .len()
}

/// The compute units of the newest transaction that touched `address`, once there are more than
/// `before` of them.
pub async fn units_of_next(address: &Pubkey, before: usize) -> u64 {
    for _ in 0..40 {
        let signatures = rpc(&cluster().url)
            .get_signatures_for_address(address)
            .await
            .unwrap();
        if signatures.len() > before {
            return units_of(&signatures[0].signature).await;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("no new transaction touched {address}");
}

/// What one more step of a program address search costs: a bump below 255 means that many more
/// hashes and curve checks than the best case.
const SEARCH_STEP: u64 = 1_500;

/// The bumps of a lock's `Lock`, `Ledger` and escrow addresses.
pub fn lock_bumps(key: &[u8; 33], lock_seq: u32) -> [u8; 3] {
    let (lock, lock_bump) = program().find_lock_pda(key, lock_seq);
    [
        lock_bump,
        program().find_ledger_pda(&lock).1,
        program().find_escrow_pda(&lock).1,
    ]
}

/// The bumps of the addresses an onboarding creates: `Device`, `Lock`, `Ledger` and the escrow.
pub fn onboarding_bumps(key: &[u8; 33]) -> [u8; 4] {
    let [lock, ledger, escrow] = lock_bumps(key, 0);
    [program().find_device_pda(key).1, lock, ledger, escrow]
}

/// Like `within`, for an instruction that searches for the addresses with `bumps`: the ceiling is
/// the one at the best case (every first bump 255) plus what the searches really took, so the
/// result does not depend on the random key.
pub fn within_searching(
    name: &str,
    measured: u64,
    ceiling: u64,
    bumps: &[u8],
    size: usize,
    size_ceiling: usize,
) {
    let searches: u64 = bumps
        .iter()
        .map(|bump| SEARCH_STEP * u64::from(255 - bump))
        .sum();
    println!(
        "{name}: {} CU at the best case, {searches} CU of address searches",
        measured.saturating_sub(searches)
    );
    within(name, measured, ceiling + searches, size, size_ceiling);
}

/// Prints `name: measured / ceiling` and holds the measure to the ceiling.
pub fn within(name: &str, measured: u64, ceiling: u64, size: usize, size_ceiling: usize) {
    println!("{name}: {measured} CU / {ceiling} CU, {size} B / {size_ceiling} B");
    assert!(measured <= ceiling, "{name}: {measured} CU");
    assert!(size <= size_ceiling, "{name}: {size} B");
}

/// How a relay to the validator misbehaves.
#[derive(Clone, Copy)]
pub enum Fault {
    /// The validator takes a `sendTransaction`, and the client is told nothing: the transaction
    /// lands and its outcome is unknown.
    CutAfterSend,
    /// A `simulateTransaction` is answered this much later.
    DelaySimulation(Duration),
}

/// A JSON-RPC relay to `target` that misbehaves as `fault` says, for one gateway to talk through.
pub async fn faulty_relay(target: &str, fault: Fault) -> String {
    use axum::{extract::State, response::IntoResponse, routing::post};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn forward(target: &str, body: &str) -> String {
        let mut stream = tokio::net::TcpStream::connect(target).await.unwrap();
        let request = format!(
            "POST / HTTP/1.1\r\nHost: {target}\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut reply = Vec::new();
        stream.read_to_end(&mut reply).await.unwrap();
        let reply = String::from_utf8(reply).unwrap();
        let (head, rest) = reply.split_once("\r\n\r\n").unwrap();
        if !head
            .to_ascii_lowercase()
            .contains("transfer-encoding: chunked")
        {
            return rest.to_owned();
        }
        let (mut out, mut rest) = (String::new(), rest);
        while let Some((size, tail)) = rest.split_once("\r\n") {
            let size = usize::from_str_radix(size.trim(), 16).unwrap();
            if size == 0 {
                break;
            }
            out.push_str(&tail[..size]);
            rest = &tail[size + 2..];
        }
        out
    }

    async fn handle(
        State(state): State<Arc<(String, Fault)>>,
        body: String,
    ) -> axum::response::Response {
        let method = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|request| request["method"].as_str().map(str::to_owned))
            .unwrap_or_default();
        if let Fault::DelaySimulation(delay) = state.1
            && method == "simulateTransaction"
        {
            tokio::time::sleep(delay).await;
        }
        let reply = forward(&state.0, &body).await;
        if matches!(state.1, Fault::CutAfterSend) && method == "sendTransaction" {
            return StatusCode::BAD_GATEWAY.into_response();
        }
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            reply,
        )
            .into_response()
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().route("/", post(handle)).with_state(Arc::new((
        target.trim_start_matches("http://").to_owned(),
        fault,
    )));
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

/// Closes an empty token account of `wallet`, as a wallet may: its rent goes to the test payer.
pub async fn close_token_account(wallet: &Wallet) {
    send(
        &[Instruction {
            program_id: chain::TOKEN_PROGRAM,
            accounts: vec![
                AccountMeta::new(wallet.token, false),
                AccountMeta::new(cluster().payer.pubkey(), false),
                AccountMeta::new_readonly(wallet.keypair.pubkey(), true),
            ],
            data: vec![9],
        }],
        &[&wallet.keypair],
    )
    .await;
}
