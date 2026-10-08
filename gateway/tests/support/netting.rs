//! Netting records against the validator: the Go fixtures re-signed for the short-windows program, the bodies the
//! gateway takes, and the RPC fronts that make a send's outcome lost or raced on the real validator.
use super::*;
use async_trait::async_trait;
use buckspay_gateway::{
    nettings::{NettingCaps, Nettings},
    zk::Zk,
};
use buckspay_protocol::{
    netting::{MAX_PARTICIPANTS, NettingStatement},
    record,
};
use ed25519_dalek::{Signer as _, SigningKey};
use solana_rpc_client::{
    http_sender::HttpSender,
    rpc_client::RpcClientConfig,
    rpc_sender::{RpcSender, RpcTransportStats},
};
use solana_rpc_client_api::{
    client_error::{Error as RpcClientError, ErrorKind, Result as RpcResult},
    request::RpcRequest,
};
use std::{
    any::Any,
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
};

pub struct Fixture {
    pub statement: NettingStatement,
    pub proof: [u8; 256],
}

/// The fixture named `name` (Task 1 §1.4). Every statement byte is bound by the proof: the generator chose each
/// case's expiry so that its address suits the short-windows program id (`on_curve_short` is on the curve).
pub fn named(name: &str) -> Fixture {
    let raw = include_str!("../../../anchor/programs/buckspay/tests/fixtures/netting_proofs.json");
    let v: Value = serde_json::from_str(raw).unwrap();
    v["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .map(|c| Fixture {
            statement: NettingStatement::decode(
                &hex::decode(c["statement"].as_str().unwrap()).unwrap(),
            )
            .unwrap(),
            proof: hex::decode(c["proof"].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap(),
        })
        .expect("fixture")
}

pub fn fixture(n: u8) -> Fixture {
    named(&format!("n{n}"))
}

pub fn member(p: usize) -> SigningKey {
    SigningKey::from_bytes(&[0x40 + p as u8; 32])
}

pub fn netting_domain() -> [u8; 32] {
    domain(
        purpose::NETTING,
        &DEVNET_GENESIS_HASH,
        &program().id().to_bytes(),
    )
}

pub fn body_of(s: &NettingStatement) -> Vec<u8> {
    let mut out = [0u8; 111 + 32 * MAX_PARTICIPANTS];
    let len = s.encode(&mut out);
    out[..len].to_vec()
}

pub fn signatures_under(s: &NettingStatement, domain: &[u8; 32]) -> Vec<[u8; 64]> {
    let m = s.envelope(domain);
    (0..usize::from(s.participants))
        .map(|p| member(p).sign(&m).to_bytes())
        .collect()
}

pub fn signatures(s: &NettingStatement) -> Vec<[u8; 64]> {
    signatures_under(s, &netting_domain())
}

pub fn request_under(s: &NettingStatement, proof: &[u8; 256], domain: &[u8; 32]) -> Value {
    json!({
        "statement": hex::encode(body_of(s)),
        "signatures": signatures_under(s, domain).iter().map(hex::encode).collect::<Vec<_>>(),
        "proof": hex::encode(proof),
    })
}

pub fn request(s: &NettingStatement, proof: &[u8; 256]) -> Value {
    request_under(s, proof, &netting_domain())
}

static FRESH: AtomicU32 = AtomicU32::new(0);

/// A proved n = 5 netting no other call of this test binary returns (`n5_00` … `n5_23`), so its record is new.
pub async fn fresh() -> (NettingStatement, [u8; 256]) {
    let k = FRESH.fetch_add(1, Ordering::SeqCst);
    assert!(k < 24, "the fixture set holds twenty-four fresh nettings");
    let f = named(&format!("n5_{k:02}"));
    (f.statement, f.proof)
}

pub fn netting_address(content: &[u8; 32]) -> Pubkey {
    Pubkey::new_from_array(record::netting_address(&program().id().to_bytes(), content).unwrap())
}

pub fn temp_store() -> std::path::PathBuf {
    tempfile::tempdir().unwrap().keep().join("nettings.json")
}

pub fn wide() -> NettingCaps {
    NettingCaps {
        daily: 100,
        ip_hourly: 1_000,
        quote_ttl: 600,
        store: temp_store(),
    }
}

/// Tests that pause the program or count the sponsor's balance run one at a time.
pub async fn serial() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    LOCK.lock().await
}

/// Forwards every request to the validator; the answer to the first `lose` sends is replaced by a transport
/// error, so the gateway cannot know whether the transaction landed (it did).
pub struct LostAnswers {
    pub inner: HttpSender,
    pub lose: AtomicU32,
    pub sends: AtomicU32,
}

#[async_trait]
impl RpcSender for LostAnswers {
    async fn send(&self, request: RpcRequest, params: Value) -> RpcResult<Value> {
        let answer = self.inner.send(request, params).await;
        if request == RpcRequest::SendTransaction {
            self.sends.fetch_add(1, Ordering::SeqCst);
            if self
                .lose
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |l| l.checked_sub(1))
                .is_ok()
            {
                return Err(RpcClientError::from(ErrorKind::Custom(
                    "connection reset".into(),
                )));
            }
        }
        answer
    }
    fn get_transport_stats(&self) -> RpcTransportStats {
        self.inner.get_transport_stats()
    }
    fn url(&self) -> String {
        self.inner.url()
    }
}

/// The first time the gateway makes request `at` (a simulation or a send), lands `first` (a direct settlement of
/// one of its notes, paid by someone else) before forwarding it; a send is then forwarded without preflight, so it
/// lands and fails on chain.
pub struct Racing {
    pub inner: HttpSender,
    pub at: RpcRequest,
    pub first: std::sync::Mutex<Option<String>>,
}

#[async_trait]
impl RpcSender for Racing {
    async fn send(&self, request: RpcRequest, mut params: Value) -> RpcResult<Value> {
        if request == self.at {
            let first = self.first.lock().unwrap().take();
            if let Some(wire) = first {
                let signature = self
                    .inner
                    .send(
                        RpcRequest::SendTransaction,
                        json!([wire, {"encoding": "base64", "preflightCommitment": "confirmed"}]),
                    )
                    .await?;
                loop {
                    let status = self
                        .inner
                        .send(RpcRequest::GetSignatureStatuses, json!([[signature]]))
                        .await?;
                    let level = &status["value"][0]["confirmationStatus"];
                    if level == "confirmed" || level == "finalized" {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
                if request == RpcRequest::SendTransaction {
                    params[1]["skipPreflight"] = json!(true);
                }
            }
        }
        self.inner.send(request, params).await
    }
    fn get_transport_stats(&self) -> RpcTransportStats {
        self.inner.get_transport_stats()
    }
    fn url(&self) -> String {
        self.inner.url()
    }
}

/// Swallows the first `drop` sends: they never reach the validator, and the gateway hears a transport error.
pub struct Dropping {
    pub inner: HttpSender,
    pub drop: AtomicU32,
}

#[async_trait]
impl RpcSender for Dropping {
    async fn send(&self, request: RpcRequest, params: Value) -> RpcResult<Value> {
        if request == RpcRequest::SendTransaction
            && self
                .drop
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |d| d.checked_sub(1))
                .is_ok()
        {
            return Err(RpcClientError::from(ErrorKind::Custom(
                "connection reset".into(),
            )));
        }
        self.inner.send(request, params).await
    }
    fn get_transport_stats(&self) -> RpcTransportStats {
        self.inner.get_transport_stats()
    }
    fn url(&self) -> String {
        self.inner.url()
    }
}

/// A client through `sender`, which the test keeps hold of: `racing_front` and `lost_front` give it back.
pub struct Through {
    client: RpcClient,
    front: Arc<dyn Any + Send + Sync>,
}

struct Shared<S>(Arc<S>);

#[async_trait]
impl<S: RpcSender + Send + Sync + 'static> RpcSender for Shared<S> {
    async fn send(&self, request: RpcRequest, params: Value) -> RpcResult<Value> {
        self.0.send(request, params).await
    }
    fn get_transport_stats(&self) -> RpcTransportStats {
        self.0.get_transport_stats()
    }
    fn url(&self) -> String {
        self.0.url()
    }
}

pub fn through<S: RpcSender + Send + Sync + 'static>(sender: S) -> Through {
    let front = Arc::new(sender);
    Through {
        client: RpcClient::new_sender(
            Shared(Arc::clone(&front)),
            RpcClientConfig::with_commitment(CommitmentConfig::confirmed()),
        ),
        front,
    }
}

fn fronts() -> &'static Mutex<HashMap<Pubkey, Arc<dyn Any + Send + Sync>>> {
    static FRONTS: std::sync::OnceLock<Mutex<HashMap<Pubkey, Arc<dyn Any + Send + Sync>>>> =
        std::sync::OnceLock::new();
    FRONTS.get_or_init(Mutex::default)
}

fn keep(sponsor: Sponsor, front: Arc<dyn Any + Send + Sync>) -> Sponsor {
    fronts().lock().unwrap().insert(sponsor.fee_payer, front);
    sponsor
}

fn front_of<T: Send + Sync + 'static>(sponsor: &Sponsor) -> Arc<T> {
    let front = fronts()
        .lock()
        .unwrap()
        .get(&sponsor.fee_payer)
        .cloned()
        .expect("a sponsor behind a front");
    front.downcast::<T>().expect("the front of that kind")
}

impl Sponsor {
    pub fn racing_front(&self) -> Arc<Racing> {
        front_of(self)
    }
    pub fn lost_front(&self) -> Arc<LostAnswers> {
        front_of(self)
    }

    /// A gateway that reads and sends through `through`, with its own funded fee payer.
    pub async fn on_rpc(through: Through, caps: Caps) -> Sponsor {
        let Through { client, front } = through;
        let sponsor = Sponsor::on(
            client,
            funded(1_000_000_000).await,
            SponsorLimits::new(caps),
            SettlementLimits::new(float_caps()),
            settings(),
            ClientAddress::Peer,
            rents().await,
            1_000,
        );
        keep(sponsor, front)
    }

    /// A gateway that serves each network `per_minute` requests a minute.
    pub async fn with_requests_per_minute(caps: Caps, per_minute: u32) -> Sponsor {
        Sponsor::with_requests(
            &cluster().url,
            funded(1_000_000_000).await,
            SponsorLimits::new(caps),
            settings(),
            ClientAddress::Peer,
            rents().await,
            per_minute,
        )
    }

    /// A gateway with the given limits on the settlements it sponsors.
    pub async fn with_float_caps(caps: Caps, float: FloatCaps) -> Sponsor {
        Sponsor::with_float(
            &cluster().url,
            funded(1_000_000_000).await,
            SponsorLimits::new(caps),
            SettlementLimits::new(float),
            settings(),
            ClientAddress::Peer,
            rents().await,
            1_000,
        )
    }

    /// A gateway whose netting records are bounded by `caps`, offering the compiled netting key.
    pub async fn with_nettings(caps: NettingCaps) -> Sponsor {
        Self::nettings_on(rpc(&cluster().url), None, caps).await
    }

    /// The same behind a front.
    pub async fn with_nettings_on(through: Through, caps: NettingCaps) -> Sponsor {
        let Through { client, front } = through;
        Self::nettings_on(client, Some(front), caps).await
    }

    async fn nettings_on(
        client: RpcClient,
        front: Option<Arc<dyn Any + Send + Sync>>,
        caps: NettingCaps,
    ) -> Sponsor {
        let keys = buckspay_client::types::KeyHashes {
            vk: *buckspay_zk_verify::vk::NETTING_VK.sha256,
            pk: [1; 32],
            dump: [2; 32],
            ccs: [3; 32],
        };
        let sponsor = Sponsor::on_nettings(
            client,
            funded(1_000_000_000).await,
            SponsorLimits::new(super::caps()),
            SettlementLimits::new(float_caps()),
            settings(),
            ClientAddress::Peer,
            rents().await,
            1_000,
            Jobs::default(),
            Relay::default(),
            Channels::default(),
            Nettings::open(caps).unwrap().with_keys(keys),
            Zk::default().with_keys_url("https://keys.test".to_owned()),
        );
        match front {
            Some(front) => keep(sponsor, front),
            None => sponsor,
        }
    }
}

pub fn http() -> HttpSender {
    HttpSender::new(cluster().url.clone())
}

pub const MEMO: Pubkey = solana_pubkey::pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/// A confirmed transfer of `lamports` to `to` with an SPL Memo of `memo`, from a new wallet: the paid lane's payment.
pub async fn pay(to: &Pubkey, lamports: u64, memo: &str) -> String {
    let wallet = funded(lamports + 10_000_000).await;
    let ixs = [
        Instruction {
            program_id: Pubkey::default(),
            accounts: vec![
                AccountMeta::new(wallet.pubkey(), true),
                AccountMeta::new(*to, false),
            ],
            data: [&[2u8, 0, 0, 0][..], &lamports.to_le_bytes()].concat(),
        },
        Instruction {
            program_id: MEMO,
            accounts: vec![],
            data: memo.as_bytes().to_vec(),
        },
    ];
    let signature = send_as_signed(&wallet, &ixs).await;
    // The gateway reads a payment at finalized commitment.
    let rpc = rpc(&cluster().url);
    loop {
        let status = rpc
            .get_signature_statuses(&[signature])
            .await
            .unwrap()
            .value
            .remove(0);
        if status.is_some_and(|s| s.confirmation_status == Some(solana_transaction_status_client_types::TransactionConfirmationStatus::Finalized)) {
            return signature.to_string();
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

pub fn paid(s: &NettingStatement, proof: &[u8; 256], payment: &str) -> Value {
    let mut body = request(s, proof);
    body["payment"] = json!(payment);
    body
}
