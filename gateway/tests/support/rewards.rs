//! Reward claims in the gateway harness: a reward tree whose leaves have secrets the test knows,
//! recipients that hold no SOL, and the proofs of their claims read from recorded fixtures.
//!
//! Every secret and recipient is derived from a label and the tree is built once, in a fixed order,
//! so the root a claim opens is the same on every run and its proof can be made once. A claim
//! without a recorded proof fails the test; with `CLAIM_RECORD=DIR` the missing requests are written
//! to `DIR/requests.json`, and `scripts/prove-claim-requests.sh` proves them.
#![allow(dead_code)]
use super::{channels::*, *};
use axum::http::StatusCode;
use buckspay_client::{
    accounts::{RewardMint, RewardTree},
    instructions::{ClaimRewardsBuilder, SettleChannelBuilder},
    types::{ChannelWords, OneClaim, WireWord},
};
use buckspay_gateway::{
    rewards::{
        ClaimBody, ClaimEntry, ClaimRents, Pinned, Rate, RewardJobs, Rewards, SweepConfig,
        associated, create_associated_idempotent,
    },
    transactions::chain_verification,
};
use buckspay_protocol::{
    hash::{domain, purpose},
    payword::{self, Commitment},
    secp256r1,
};
use buckspay_zk_verify::{fr, vk};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_hash::Hash;
use solana_message::{VersionedMessage, v0};
use solana_transaction::versioned::VersionedTransaction;
use std::collections::HashMap;

pub const MAX_FEE: u64 = 900_000;
pub const CLAIM_FEE: u64 = 450_000;
pub const UNIT: u64 = WORD_VALUE - WORD_FEE;
pub const SOL_PRICE_MICRO_USDC: u64 = 150_000_000;
pub const PINNED: Pinned = Pinned {
    claim_cu: 400_000,
    sweep_cu: 40_000,
    priority_price: 10_000,
};
/// The claim limit per network the test gateways run with.
pub const CLAIM_IP_LIMIT: u32 = 3;

/// A leaf of the reward tree: its secrets, its exponent and where the tree holds it.
#[derive(Clone, Debug)]
pub struct Leaf {
    pub index: u32,
    pub exp: u8,
    pub nullifier: [u8; 32],
    pub trapdoor: [u8; 32],
}

fn poseidon(inputs: &[&[u8; 32]]) -> [u8; 32] {
    let inputs: Vec<&[u8]> = inputs.iter().map(|i| &i[..]).collect();
    solana_poseidon::hashv(
        solana_poseidon::Parameters::Bn254X5,
        solana_poseidon::Endianness::BigEndian,
        &inputs,
    )
    .unwrap()
    .to_bytes()
}

fn derived(label: &str, n: usize) -> [u8; 32] {
    fr::reduce(&Sha256::digest(format!("buckspay/test/claim/{label}/{n}")).into())
}

impl Leaf {
    fn new(index: u32, exp: u8) -> Self {
        Self {
            index,
            exp,
            nullifier: derived("nullifier", index as usize),
            trapdoor: derived("trapdoor", index as usize),
        }
    }

    fn inner(&self) -> [u8; 32] {
        poseidon(&[&self.nullifier, &self.trapdoor])
    }

    pub fn value(&self) -> [u8; 32] {
        let mut exp = [0u8; 32];
        exp[31] = self.exp;
        poseidon(&[&self.inner(), &exp])
    }

    fn nullifier_hash(&self, scope: &[u8; 32]) -> [u8; 32] {
        poseidon(&[&self.nullifier, scope])
    }
}

/// The leaves of the tree, in the order of the world's build. Roles by index: 0 is the leaf the
/// sweep test claims, 1 the zero-SOL claim, 2 the invalid proof, 3 the spent nullifier, 4 to 13 the
/// ten leaves of the cost test.
pub struct World {
    pub leaves: Vec<Leaf>,
    pub root: [u8; 32],
}

const EXPS: [u8; 14] = [3, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];

fn tree_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    let mut level = leaves.to_vec();
    let mut zero = [0u8; 32];
    for _ in 0..20 {
        if level.len() % 2 == 1 {
            level.push(zero);
        }
        level = level.chunks(2).map(|p| poseidon(&[&p[0], &p[1]])).collect();
        zero = poseidon(&[&zero, &zero]);
    }
    level[0]
}

fn path(words: &[[u8; 32]], index: usize) -> Vec<[u8; 32]> {
    let mut level: Vec<[u8; 32]> = words
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
    path
}

pub fn reward_mint() -> Pubkey {
    Pubkey::find_program_address(&[b"reward-mint", cluster().mint.as_ref()], &program().id()).0
}

fn tree_address() -> Pubkey {
    Pubkey::find_program_address(
        &[b"reward-tree", cluster().mint.as_ref(), &0u32.to_le_bytes()],
        &program().id(),
    )
    .0
}

pub async fn reward_mint_account() -> RewardMint {
    RewardMint::from_bytes(&account(&reward_mint()).await.unwrap().data).unwrap()
}

async fn latest_root() -> [u8; 32] {
    let tree = RewardTree::from_bytes(&account(&tree_address()).await.unwrap().data).unwrap();
    tree.roots[(tree.root_index as usize + 255) % 256]
}

/// Settles `indexes` of the payer's channel into leaves with the given inners, directly through
/// the program: the tree is the world's, built without the words flow.
async fn settle(
    payer: &Payer,
    first: bool,
    indexes: &[usize],
    inners: Vec<[u8; 32]>,
    fee: &Keypair,
) {
    let program = program();
    let lock = payer.issuer.lock();
    let hash = payer.channel_hash();
    let channel =
        Pubkey::find_program_address(&[b"channel", lock.as_ref(), &hash], &program.id()).0;
    let reward = reward_mint();
    let issuer = payer.issuer.device.key();
    let mut instructions = Vec::new();
    if first {
        let domain = domain(
            purpose::PAYWORD,
            &DEVNET_GENESIS_HASH,
            &program.id().to_bytes(),
        );
        let envelope = payword::payword_signing(&domain, &payer.commitment).unwrap();
        let entries: Vec<secp256r1::Expected> = vec![(issuer, envelope)];
        instructions.push(chain_verification(&entries, &[payer.signature]).unwrap());
    }
    let mut builder = SettleChannelBuilder::new();
    builder
        .payer(fee.pubkey())
        .reward_mint(reward)
        .pool_ledger(program.find_ledger_pda(&reward).0)
        .pool_escrow(program.find_escrow_pda(&reward).0)
        .fee_account(reward_mint_account().await.fee_account)
        .tree(tree_address())
        .mint(cluster().mint)
        .instructions(
            "Sysvar1nstructions1111111111111111111111111"
                .parse()
                .unwrap(),
        )
        .token_program(chain::TOKEN_PROGRAM)
        .system_program(Pubkey::default())
        .channels(vec![ChannelWords {
            issuer_key: issuer,
            lock_seq: 0,
            commitment: first.then(|| payer.commitment.encode()),
            words: indexes
                .iter()
                .map(|&i| WireWord {
                    index: i as u16,
                    word: payer.words[i],
                    path: path(&payer.words, i),
                })
                .collect(),
        }])
        .inners(inners)
        .add_remaining_accounts(&[
            AccountMeta::new_readonly(lock, false),
            AccountMeta::new(program.find_ledger_pda(&lock).0, false),
            AccountMeta::new(program.find_escrow_pda(&lock).0, false),
            AccountMeta::new(channel, false),
        ]);
    instructions.push(program.target(builder.instruction()));
    send_v1(fee, &instructions, 1_400_000).await;
}

/// The reward tree of the test validator, built once.
pub async fn world() -> &'static World {
    static WORLD: tokio::sync::OnceCell<World> = tokio::sync::OnceCell::const_new();
    WORLD.get_or_init(build).await
}

async fn build() -> World {
    configure_rewards().await;
    let sponsor = Sponsor::new(caps()).await;
    let fee = funded(10_000_000_000).await;
    let leaves: Vec<Leaf> = EXPS
        .iter()
        .enumerate()
        .map(|(i, exp)| Leaf::new(i as u32, *exp))
        .collect();
    // One transaction per leaf, `2^exp` words of a channel each; a channel has sixteen words, so
    // the exponents are packed in order into as many channels as they take.
    let mut channel: Option<(Payer, usize)> = None;
    for leaf in &leaves {
        let words = 1usize << leaf.exp;
        let (payer, used) = match channel.take() {
            Some((payer, used)) if used + words <= 16 => (payer, used),
            _ => (Payer::standard(&sponsor).await, 0),
        };
        let indexes: Vec<usize> = (used..used + words).collect();
        settle(&payer, used == 0, &indexes, vec![leaf.inner()], &fee).await;
        channel = Some((payer, used + words));
    }
    let values: Vec<[u8; 32]> = leaves.iter().map(Leaf::value).collect();
    let root = latest_root().await;
    assert_eq!(
        tree_root(&values),
        root,
        "the world's tree is not the chain's"
    );
    World { leaves, root }
}

/// Sends `instructions` as a transaction v1 with a compute limit of `units`.
async fn send_v1(payer: &Keypair, instructions: &[Instruction], units: u32) {
    let rpc = rpc(&cluster().url);
    let config = solana_message::v1::TransactionConfig {
        priority_fee: Some(0),
        compute_unit_limit: Some(units),
        loaded_accounts_data_size_limit: Some(2 * 1_024 * 1_024),
        heap_size: None,
    };
    let message = VersionedMessage::V1(
        solana_message::v1::Message::try_compile_with_config(
            &payer.pubkey(),
            instructions,
            rpc.get_latest_blockhash().await.unwrap(),
            config,
        )
        .unwrap(),
    );
    let transaction = VersionedTransaction {
        signatures: vec![payer.sign_message(&message.serialize())],
        message,
    };
    rpc.send_and_confirm_transaction(&transaction)
        .await
        .unwrap();
}

/// A keypair that is always the same for `label`: no SOL, no token account.
pub fn fresh_keypair(label: &str) -> Keypair {
    Keypair::new_from_array(Sha256::digest(format!("buckspay/test/wallet/{label}")).into())
}

fn scope() -> [u8; 32] {
    let hash = Sha256::new()
        .chain_update(b"buckspay/reward")
        .chain_update(program().id())
        .chain_update(cluster().mint)
        .chain_update(DEVNET_GENESIS_HASH)
        .finalize();
    fr::reduce(&hash.into())
}

fn word(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(bytes);
    out
}

#[derive(Serialize)]
struct Request {
    leaves: Vec<String>,
    index: u32,
    nullifier: String,
    trapdoor: String,
    exp: u8,
    scope: String,
    recipient: String,
    max_fee: u64,
}

#[derive(Deserialize)]
struct Stored {
    claims: Vec<StoredProof>,
}

#[derive(Deserialize)]
struct StoredProof {
    key: String,
    compressed: String,
}

fn store() -> &'static HashMap<String, [u8; 128]> {
    static STORE: std::sync::OnceLock<HashMap<String, [u8; 128]>> = std::sync::OnceLock::new();
    STORE.get_or_init(|| {
        let stored: Stored =
            serde_json::from_str(include_str!("../fixtures/claim_proofs.json")).unwrap();
        stored
            .claims
            .into_iter()
            .map(|p| {
                (
                    p.key,
                    hex::decode(p.compressed).unwrap().try_into().unwrap(),
                )
            })
            .collect()
    })
}

static RECORDED: std::sync::Mutex<Vec<(String, serde_json::Value)>> =
    std::sync::Mutex::new(Vec::new());

/// The proof of `leaf` for `owner` under the world's root, from the fixtures.
pub async fn proof(leaf: &Leaf, owner: &Pubkey) -> [u8; 128] {
    let world = world().await;
    let scope = scope();
    let bytes = owner.to_bytes();
    let key: String = [
        world.root,
        leaf.nullifier_hash(&scope),
        scope,
        word(&bytes[..16]),
        word(&bytes[16..]),
        word(&[leaf.exp]),
        word(&MAX_FEE.to_be_bytes()),
    ]
    .iter()
    .map(hex::encode)
    .collect();
    if let Some(proof) = store().get(&key) {
        return *proof;
    }
    let Ok(dir) = std::env::var("CLAIM_RECORD") else {
        panic!("no proof for claim {key}: run scripts/prove-claim-requests.sh");
    };
    let request = Request {
        leaves: world
            .leaves
            .iter()
            .map(|l| hex::encode(l.value()))
            .collect(),
        index: leaf.index,
        nullifier: hex::encode(leaf.nullifier),
        trapdoor: hex::encode(leaf.trapdoor),
        exp: leaf.exp,
        scope: hex::encode(scope),
        recipient: hex::encode(owner),
        max_fee: MAX_FEE,
    };
    let mut recorded = RECORDED.lock().unwrap();
    if recorded.iter().any(|(recorded, _)| *recorded == key) {
        return [0u8; 128];
    }
    recorded.push((key, serde_json::to_value(request).unwrap()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        format!("{dir}/requests.json"),
        serde_json::to_string(&recorded.iter().map(|(_, v)| v).collect::<Vec<_>>()).unwrap(),
    )
    .unwrap();
    [0u8; 128]
}

/// The body of `POST /v1/claims` for `leaves`, to `owner`, proved against the world's root.
pub async fn claim_body(leaves: &[Leaf], owner: &Pubkey) -> ClaimBody {
    let world = world().await;
    let scope = scope();
    let mut claims = Vec::new();
    for leaf in leaves {
        claims.push(ClaimEntry {
            epoch: 0,
            root: BASE64_STANDARD.encode(world.root),
            nullifier_hash: BASE64_STANDARD.encode(leaf.nullifier_hash(&scope)),
            exp: leaf.exp,
            proof: BASE64_STANDARD.encode(proof(leaf, owner).await),
        });
    }
    ClaimBody {
        vk_sha256: BASE64_STANDARD.encode(vk::CLAIM.sha256),
        recipient: owner.to_string(),
        max_fee: MAX_FEE,
        claims,
    }
}

/// What `POST /v1/claims` and `POST /v1/sweeps` answered.
#[derive(Debug)]
pub struct Reply {
    pub status: String,
    pub reason: Option<String>,
    pub job_key: Option<String>,
    pub signature: Option<String>,
    pub compute_units: Option<u64>,
}

impl From<Value> for Reply {
    fn from(value: Value) -> Self {
        let text = |name: &str| value[name].as_str().map(str::to_owned);
        Self {
            status: text("status").unwrap_or_else(|| value.to_string()),
            reason: text("reason"),
            job_key: text("jobKey"),
            signature: text("signature"),
            compute_units: value["computeUnits"].as_u64(),
        }
    }
}

/// A gateway on the test validator with rewards on, and its own funded fee payer.
pub struct Gw {
    pub sponsor: Sponsor,
    pub peer: String,
    pub fee_account: Pubkey,
    pub rents: ClaimRents,
}

pub async fn rents_of_claims() -> ClaimRents {
    let rpc = rpc(&cluster().url);
    ClaimRents {
        nullifier: rpc.get_minimum_balance_for_rent_exemption(0).await.unwrap(),
        token_account: rpc
            .get_minimum_balance_for_rent_exemption(165)
            .await
            .unwrap(),
    }
}

pub async fn start_with_rewards(peer: &str) -> Gw {
    start_with(peer, Some(Rate::per_sol(SOL_PRICE_MICRO_USDC))).await
}

pub async fn start_with(peer: &str, rate: Option<Rate>) -> Gw {
    start_with_budget(peer, rate, 1_000_000_000).await
}

pub async fn start_with_budget(peer: &str, rate: Option<Rate>, daily_budget: u64) -> Gw {
    start_with_keys(peer, rate, daily_budget, None).await
}

pub async fn start_with_keys(
    peer: &str,
    rate: Option<Rate>,
    daily_budget: u64,
    keys_url: Option<&str>,
) -> Gw {
    world().await;
    let fee_account = token_account(&Keypair::new().pubkey(), 0).await;
    let mut settings = settings();
    settings.fee_token = Some(fee_account);
    let fee_payer = funded(1_000_000_000).await;
    let fee_payer_address = fee_payer.pubkey();
    let mut gateway = Gateway::new(
        rpc(&cluster().url),
        fee_payer,
        settings,
        rents().await,
        Limits {
            requests: RequestLimits::new(std::num::NonZeroU32::new(1_000).unwrap()),
            sponsor: SponsorLimits::new(caps()),
            settlements: SettlementLimits::new(float_caps()),
        },
        hpke(),
    )
    .with_rewards(
        Rewards::new(PINNED, rate, daily_budget, RewardJobs::default())
            .with_claim_ip_limit(CLAIM_IP_LIMIT),
    );
    if let Some(url) = keys_url {
        gateway = gateway.with_zk(
            buckspay_gateway::zk::Zk::new(std::num::NonZeroU32::new(1_000).unwrap())
                .with_keys_url(url.to_owned()),
        );
    }
    let gateway = std::sync::Arc::new(gateway);
    Gw {
        sponsor: Sponsor {
            fee_payer: fee_payer_address,
            app: router(std::sync::Arc::clone(&gateway), ClientAddress::Peer),
            gateway,
        },
        peer: peer.to_owned(),
        fee_account,
        rents: rents_of_claims().await,
    }
}

impl Gw {
    pub fn rate(&self) -> Rate {
        Rate::per_sol(SOL_PRICE_MICRO_USDC)
    }

    pub async fn leaf(&self, index: usize) -> Leaf {
        world().await.leaves[index].clone()
    }

    pub async fn get(&self, path: &str) -> (StatusCode, Vec<u8>) {
        get_raw(&self.sponsor, self.peer.split(':').next().unwrap(), path).await
    }

    pub async fn leaves(&self, indexes: std::ops::Range<usize>) -> Vec<Leaf> {
        world().await.leaves[indexes].to_vec()
    }

    pub async fn post_claims(&self, body: &ClaimBody) -> Reply {
        self.post_claims_as(&self.peer, body).await
    }

    pub async fn post_claims_as(&self, peer: &str, body: &ClaimBody) -> Reply {
        let body = serde_json::to_string(body).unwrap();
        let (status, value) = self.sponsor.post_from(peer, "/v1/claims", body).await;
        assert_eq!(status, StatusCode::OK, "{value}");
        value.into()
    }

    pub async fn post_raw(&self, path: &str, body: String) -> Reply {
        let (status, value) = self.sponsor.post_from(&self.peer, path, body).await;
        assert_eq!(status, StatusCode::OK, "{value}");
        value.into()
    }

    pub async fn until_settled(&self, key: &str) -> Reply {
        for _ in 0..240 {
            let (_, value) = self
                .sponsor
                .get(&self.peer, &format!("/v1/claims/{key}"))
                .await;
            let reply: Reply = value.into();
            if reply.status != "submitted" {
                return reply;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        panic!("the job never ended");
    }

    pub async fn fee_payer_lamports(&self) -> u64 {
        balance(&self.sponsor.fee_payer).await
    }

    pub async fn sent_transactions(&self) -> usize {
        transactions_of(&self.sponsor.fee_payer).await
    }

    pub fn native_verifications(&self) -> u64 {
        self.sponsor.gateway.rewards.verifications()
    }

    pub async fn token_balance_of(&self, owner: &Pubkey) -> u64 {
        token_balance(&associated(owner, &cluster().mint)).await
    }

    pub async fn lamports(&self, owner: &Pubkey) -> u64 {
        balance(owner).await
    }

    pub async fn fee_account_balance(&self) -> u64 {
        token_balance(&reward_mint_account().await.fee_account).await
    }

    /// Another submitter spends the leaf's nullifier on chain: the program's own instruction, paid
    /// for by a wallet of the test.
    pub async fn claim_directly_on_chain(&self, leaf: &Leaf, owner: &Keypair) {
        let program = program();
        let reward = reward_mint();
        let world = world().await;
        let mint_account = reward_mint_account().await;
        let nullifier_hash = leaf.nullifier_hash(&scope());
        let payer = funded(10_000_000_000).await;
        let recipient = associated(&owner.pubkey(), &cluster().mint);
        let mut builder = ClaimRewardsBuilder::new();
        builder
            .payer(payer.pubkey())
            .reward_config(Pubkey::find_program_address(&[b"reward-config"], &program.id()).0)
            .reward_mint(reward)
            .pool_ledger(program.find_ledger_pda(&reward).0)
            .pool_escrow(program.find_escrow_pda(&reward).0)
            .fee_account(mint_account.fee_account)
            .recipient(recipient)
            .mint(cluster().mint)
            .token_program(chain::TOKEN_PROGRAM)
            .system_program(Pubkey::default())
            .vk_sha256(*vk::CLAIM.sha256)
            .max_fee(MAX_FEE)
            .claims(vec![OneClaim {
                epoch: 0,
                root: world.root,
                nullifier_hash,
                exp: leaf.exp,
                proof: proof(leaf, &owner.pubkey()).await,
            }])
            .add_remaining_accounts(&[
                AccountMeta::new_readonly(tree_address(), false),
                AccountMeta::new(
                    Pubkey::find_program_address(
                        &[b"reward-null", cluster().mint.as_ref(), &nullifier_hash],
                        &program.id(),
                    )
                    .0,
                    false,
                ),
            ]);
        send_v1(
            &payer,
            &[
                create_associated_idempotent(&payer.pubkey(), &owner.pubkey(), &cluster().mint),
                program.target(builder.instruction()),
            ],
            400_000,
        )
        .await;
    }

    /// The config a sweep of this gateway is checked against.
    pub fn sweep_config(&self) -> SweepConfig {
        SweepConfig::new(
            PINNED,
            self.sponsor.fee_payer,
            (cluster().mint, 6),
            self.fee_account,
            self.rate(),
            &self.rents,
        )
    }

    /// A sweep from `fresh` to a new token account of `to`, signed by `fresh` alone.
    pub async fn sweep_body(&self, fresh: &Keypair, to: &Pubkey, amount: u64, fee: u64) -> String {
        self.sweep_body_with(
            fresh,
            to,
            amount,
            fee,
            (PINNED.sweep_cu, PINNED.priority_price),
        )
        .await
    }

    /// The same sweep under the compute limit and price given.
    pub async fn sweep_body_with(
        &self,
        fresh: &Keypair,
        to: &Pubkey,
        amount: u64,
        fee: u64,
        (limit, price): (u32, u64),
    ) -> String {
        let (source, destination) = (
            associated(&fresh.pubkey(), &cluster().mint),
            associated(to, &cluster().mint),
        );
        let transfer = |to: Pubkey, amount: u64| {
            let mut data = vec![12];
            data.extend_from_slice(&amount.to_le_bytes());
            data.push(6);
            Instruction {
                program_id: chain::TOKEN_PROGRAM,
                accounts: vec![
                    AccountMeta::new(source, false),
                    AccountMeta::new_readonly(cluster().mint, false),
                    AccountMeta::new(to, false),
                    AccountMeta::new_readonly(fresh.pubkey(), true),
                ],
                data,
            }
        };
        let instructions = [
            ComputeBudgetInstruction::set_compute_unit_limit(limit),
            ComputeBudgetInstruction::set_compute_unit_price(price),
            create_associated_idempotent(&self.sponsor.fee_payer, to, &cluster().mint),
            transfer(destination, amount),
            transfer(self.fee_account, fee),
        ];
        let blockhash: Hash = rpc(&cluster().url).get_latest_blockhash().await.unwrap();
        let message =
            v0::Message::try_compile(&self.sponsor.fee_payer, &instructions, &[], blockhash)
                .unwrap();
        let signature = fresh.sign_message(&VersionedMessage::V0(message.clone()).serialize());
        let transaction = VersionedTransaction {
            signatures: vec![Signature::default(), signature],
            message: VersionedMessage::V0(message),
        };
        json!({ "transaction": BASE64_STANDARD.encode(bincode::serialize(&transaction).unwrap()) })
            .to_string()
    }
}
