//! Delivery words in the gateway harness: the reward pool, payers with a signed commitment and the
//! relayers that receive their words, hold them and settle them through the gateway.
#![allow(dead_code)]
use super::{relay::*, *};
use base64::{Engine, prelude::BASE64_STANDARD};
use buckspay_client::instructions::{InitRewardConfigBuilder, InitRewardMintBuilder};
use buckspay_gateway::{
    channels::Channels,
    hpke::info,
    relay::Relay,
    words::{WORD_AAD, WORD_PAD},
};
use buckspay_protocol::{
    cluster::DEVNET_GENESIS_HASH,
    hash::{domain, purpose},
    payword::{self, Commitment},
};
use hpke::{
    Deserializable, OpModeR, Serializable, aead::ChaCha20Poly1305 as HpkeChaCha, kdf::HkdfSha256,
};
use sha2::{Digest, Sha256};

pub const WORD_VALUE: u64 = 500_000;
pub const WORD_FEE: u64 = 10_000;
pub const WORDS: usize = 16;
pub const BOND: u64 = 40_000_000;
pub const BACKING: u64 = 20_000_000;

fn reward_config() -> Pubkey {
    Pubkey::find_program_address(&[b"reward-config"], &program().id()).0
}

fn reward_mint() -> Pubkey {
    Pubkey::find_program_address(&[b"reward-mint", cluster().mint.as_ref()], &program().id()).0
}

/// Configures the reward pool of the test validator once: the config with the upgrade authority
/// as admin, and the mint with its word value and fee.
pub async fn configure_rewards() {
    static DONE: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
    DONE.get_or_init(|| async {
        let authority = zk::admin();
        zk::airdrop(&authority.pubkey(), 10_000_000_000).await;
        let mut config = InitRewardConfigBuilder::new();
        config
            .authority(authority.pubkey())
            .reward_config(reward_config())
            .program(program().id())
            .program_data(zk::program_data())
            .system_program(Pubkey::default())
            .admin(authority.pubkey())
            .pauser(authority.pubkey());
        send_as(&authority, &[program().target(config.instruction())]).await;
        let reward_mint = reward_mint();
        let mut mint = InitRewardMintBuilder::new();
        mint.admin(authority.pubkey())
            .reward_config(reward_config())
            .mint(cluster().mint)
            .reward_mint(reward_mint)
            .pool_ledger(program().find_ledger_pda(&reward_mint).0)
            .pool_escrow(program().find_escrow_pda(&reward_mint).0)
            .tree(
                Pubkey::find_program_address(
                    &[b"reward-tree", cluster().mint.as_ref(), &0u32.to_le_bytes()],
                    &program().id(),
                )
                .0,
            )
            .token_program(chain::TOKEN_PROGRAM)
            .system_program(Pubkey::default())
            .word_value(WORD_VALUE)
            .word_fee(WORD_FEE)
            .max_fee(900_000)
            .claim_fee(450_000)
            .fee_account(zk::fee_account().await)
            .claim_cap(500_000_000);
        send_as(&authority, &[program().target(mint.instruction())]).await;
    })
    .await;
}

/// A gateway on the validator that relays instantly, with the channel caps given.
pub async fn gateway(relay: Relay, channels: Channels) -> Sponsor {
    configure_rewards().await;
    Sponsor::on_channels(
        rpc(&cluster().url),
        funded(1_000_000_000).await,
        SponsorLimits::new(caps()),
        SettlementLimits::new(float_caps()),
        settings(),
        ClientAddress::Peer,
        rents().await,
        1_000,
        Jobs::default(),
        relay,
        channels,
    )
}

fn payword_domain() -> [u8; 32] {
    domain(
        purpose::PAYWORD,
        &DEVNET_GENESIS_HASH,
        &program().id().to_bytes(),
    )
}

/// The blob a relayer is handed, with what the payer needs to read its answer.
pub struct Blob {
    pub bytes: Vec<u8>,
    pub id: String,
    pub opener: Opener,
}

/// A payer with a funded lock, a channel of sixteen words and a payee to pay.
pub struct Payer {
    pub issuer: Issuer,
    pub words: Vec<[u8; 32]>,
    pub commitment: Commitment,
    pub signature: [u8; 64],
    pub payee: Wallet,
    next_note: u64,
}

impl Payer {
    /// A lock of `bond` and `backing` and a channel at the top of the backing.
    pub async fn new(sponsor: &Sponsor, bond: u64, backing: u64) -> Self {
        let issuer = Issuer::new(sponsor, bond, backing, 3_000).await;
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).unwrap();
        let words: Vec<[u8; 32]> = (0..WORDS as u16)
            .map(|i| Sha256::digest([seed.as_slice(), &i.to_be_bytes()].concat()).into())
            .collect();
        let commitment = Commitment {
            mint: cluster().mint.to_bytes(),
            lock_seq: 0,
            cum_end: backing,
            depth: 4,
            word_value: WORD_VALUE,
            root: payword::root(&words),
            expiry: issuer.lock_until - 200,
        };
        let envelope = payword::payword_signing(&payword_domain(), &commitment).unwrap();
        let signature = issuer.device.sign(&envelope);
        Self {
            issuer,
            words,
            commitment,
            signature,
            payee: associated_wallet(0).await,
            next_note: 0,
        }
    }

    pub async fn standard(sponsor: &Sponsor) -> Self {
        Self::new(sponsor, BOND, BACKING).await
    }

    pub fn channel_hash(&self) -> [u8; 32] {
        self.commitment.hash()
    }

    fn proof(&self, index: usize) -> Vec<u8> {
        let mut level: Vec<[u8; 32]> = self
            .words
            .iter()
            .enumerate()
            .map(|(i, w)| payword::leaf(i as u16, w))
            .collect();
        let (mut at, mut path) = (index, vec![]);
        while level.len() > 1 {
            path.push(level[at ^ 1]);
            level = level
                .chunks(2)
                .map(|pair| payword::node(&pair[0], &pair[1]))
                .collect();
            at /= 2;
        }
        payword::WordProof {
            index: index as u16,
            word: self.words[index],
            path,
        }
        .encode()
    }

    fn word_bytes(&self, index: usize) -> Vec<u8> {
        let proof = self.proof(index);
        let mut bytes = self.commitment.encode().to_vec();
        bytes.extend(self.signature);
        bytes.extend((proof.len() as u16).to_be_bytes());
        bytes.extend(proof);
        bytes
    }

    /// A payment to the payee from the next free part of the backing, expiring in
    /// `expiry_from_now` seconds (negative: already past), tipping with the word `index`.
    pub async fn payment(&mut self, index: Option<usize>, expiry_from_now: i64) -> Blob {
        self.payment_of(2_000_000, index, expiry_from_now).await
    }

    /// The same for `amount` units.
    pub async fn payment_of(
        &mut self,
        amount: u64,
        index: Option<usize>,
        expiry_from_now: i64,
    ) -> Blob {
        let expiry = u32::try_from(i64::from(chain_now().await) + expiry_from_now).unwrap();
        let note = self.issuer.issue_to_account(
            self.next_note,
            amount,
            expiry,
            &self.payee.keypair.pubkey(),
        );
        self.next_note += amount;
        let word = index.map(|i| self.word_bytes(i));
        let plain = inner(&note, 1024, word.as_deref());
        let (key_id, public) = gateway_key();
        let (bytes, opener) = seal_with(key_id, &public, "relay", DEVNET_GENESIS_HASH, &plain);
        Blob {
            id: hex::encode(Sha256::digest(&bytes)),
            bytes,
            opener,
        }
    }

    /// A payment that settles: it lives long enough for the whole test.
    pub async fn tip(&mut self, index: usize) -> Blob {
        self.payment(Some(index), 600).await
    }
}

/// A relayer key: the secret it keeps and the public key it posts.
pub struct Rk {
    secret: <Kem as hpke::Kem>::PrivateKey,
    pub public: [u8; 32],
}

pub fn rk() -> Rk {
    let mut ikm = [0u8; 32];
    getrandom::fill(&mut ikm).unwrap();
    let (secret, public) = <Kem as hpke::Kem>::derive_keypair(&ikm);
    Rk {
        secret,
        public: public.to_bytes().as_slice().try_into().unwrap(),
    }
}

/// A word a relayer opened: the commitment, the issuer's signature and the proof.
#[derive(Clone)]
pub struct Word {
    pub commitment: Vec<u8>,
    pub signature: Vec<u8>,
    pub proof: Vec<u8>,
}

impl Rk {
    /// The word sealed to this key, or `None` if it is not for it.
    pub fn open_word(&self, sealed: &[u8]) -> Option<Word> {
        let (enc, ciphertext) = sealed.split_at_checked(32)?;
        let enc = <Kem as hpke::Kem>::EncappedKey::from_bytes(enc).ok()?;
        let mut context = hpke::setup_receiver::<HpkeChaCha, HkdfSha256, Kem>(
            &OpModeR::Base,
            &self.secret,
            &enc,
            &info("word", &DEVNET_GENESIS_HASH),
        )
        .ok()?;
        let plain = context.open(ciphertext, WORD_AAD).ok()?;
        assert_eq!(plain.len(), WORD_PAD, "every word has the same length");
        let commitment = Commitment::decode(&plain[..payword::COMMITMENT_LEN]).ok()?;
        let proof_len = 2 + 32 + 32 * usize::from(commitment.depth);
        let at = payword::COMMITMENT_LEN + 64;
        Some(Word {
            commitment: plain[..payword::COMMITMENT_LEN].to_vec(),
            signature: plain[payword::COMMITMENT_LEN..at].to_vec(),
            proof: plain[at..at + proof_len].to_vec(),
        })
    }
}

pub async fn get_raw(sponsor: &Sponsor, peer: &str, path: &str) -> (StatusCode, Vec<u8>) {
    let peer: SocketAddr = format!("{peer}:4000").parse().unwrap();
    let response = sponsor
        .app
        .clone()
        .layer(MockConnectInfo(peer))
        .oneshot(Request::get(path).body(Body::empty()).unwrap())
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

/// Posts `blob` with the relayer key `rk`, and returns the status the payer reads.
pub async fn post_with_rk(sponsor: &Sponsor, peer: &str, blob: &Blob, rk: Option<&Rk>) -> String {
    let mut body = blob.bytes.clone();
    if let Some(rk) = rk {
        body.extend(rk.public);
    }
    let (status, answer) = post_relay(sponsor, peer, body).await;
    assert_eq!(status, StatusCode::OK);
    blob.opener.status(&answer)
}

/// A different network for every poll, so that polling is never what a test runs into.
fn poller(round: usize) -> String {
    format!("198.{}.113.50", round % 200)
}

pub async fn word_status(sponsor: &Sponsor, id: &str) -> StatusCode {
    get_raw(sponsor, &poller(0), &format!("/v1/relay/{id}/word"))
        .await
        .0
}

/// Waits until the word of `blob` is served, for as long as a settlement takes.
pub async fn sealed_word(sponsor: &Sponsor, id: &str) -> Vec<u8> {
    for round in 0..240 {
        let (status, body) =
            get_raw(sponsor, &poller(round), &format!("/v1/relay/{id}/word")).await;
        if status == StatusCode::OK {
            return body;
        }
        assert_ne!(status, StatusCode::GONE, "the word is gone");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("the word was never released");
}

/// Waits for the payment of `blob` to be paid out and the status of its word to settle.
pub async fn until_final(sponsor: &Sponsor, id: &str) -> StatusCode {
    for round in 0..240 {
        let status = get_raw(sponsor, &poller(round), &format!("/v1/relay/{id}/word"))
            .await
            .0;
        if status != StatusCode::NOT_FOUND {
            return status;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    StatusCode::NOT_FOUND
}

/// A relayer that holds the words it was given.
#[derive(Default)]
pub struct Relayer {
    pub held: Vec<Word>,
}

impl Relayer {
    /// Delivers `blob` to the gateway with a fresh key, waits for its word and keeps it.
    pub async fn deliver(&mut self, sponsor: &Sponsor, peer: &str, blob: &Blob) {
        let key = rk();
        assert_eq!(
            post_with_rk(sponsor, peer, blob, Some(&key)).await,
            "submitted"
        );
        let sealed = sealed_word(sponsor, &blob.id).await;
        self.held
            .push(key.open_word(&sealed).expect("the word opens"));
    }

    /// The body of `POST /v1/channels` for the held words from `from`, one inner per exponent.
    pub fn batch(&self, from: usize, count: usize) -> Value {
        let words = &self.held[from..from + count];
        let mut channels: Vec<(Vec<u8>, Vec<String>)> = vec![];
        for word in words {
            let proof = BASE64_STANDARD.encode(&word.proof);
            match channels.iter_mut().find(|(c, _)| *c == word.commitment) {
                Some((_, proofs)) => proofs.push(proof),
                None => channels.push((word.commitment.clone(), vec![proof])),
            }
        }
        let exps = payword::canonical_exps(count as u32).expect("an even number of words");
        let inners: Vec<String> = exps
            .iter()
            .map(|_| {
                let mut inner = [0u8; 32];
                getrandom::fill(&mut inner[1..]).unwrap();
                BASE64_STANDARD.encode(inner)
            })
            .collect();
        json!({
            "channels": channels
                .iter()
                .map(|(commitment, words)| json!({
                    "commitment": BASE64_STANDARD.encode(commitment),
                    "words": words,
                }))
                .collect::<Vec<_>>(),
            "inners": inners,
        })
    }
}

pub async fn post_channels(sponsor: &Sponsor, peer: &str, body: &Value) -> Value {
    let (status, answer) = sponsor
        .post_from(&format!("{peer}:4000"), "/v1/channels", body.to_string())
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    answer
}

/// Waits for a batch to land or fail, and returns the job's status.
pub async fn until_batch_ends(sponsor: &Sponsor, job_key: &str) -> Value {
    for round in 0..240 {
        let (_, status) = sponsor
            .get(
                &format!("{}:4000", poller(round)),
                &format!("/v1/channels/{job_key}"),
            )
            .await;
        if status["status"] != "submitted" {
            return status;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("the batch never ended");
}
