//! Claims against the reward pool: leaves with known secrets, wallets with no SOL, and proofs read
//! from recorded fixtures. Every secret, wallet and amount is derived from a counter, so the root a
//! claim opens is the same on every run and its proof can be made once.
//!
//! A claim without a recorded proof fails the test. With `CLAIM_RECORD=DIR` the missing requests are
//! written to `DIR/requests_<current|previous>.json`; `scripts/prove-claim-fixtures.sh` proves them
//! under the claim keys and stores the proofs next to the other fixtures.
use super::super::poseidon::poseidon2;
use super::*;
use anchor_lang::{AccountSerialize, InstructionData, ToAccountMetas};
use buckspay::{ClaimArgs, OneClaim, RewardConfig};
use buckspay_zk_verify::{fr, vk};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

pub const NULLIFIER_SEED: &[u8] = b"reward-null";

/// A leaf the program computed from the inner of a relayer whose secrets the test knows.
#[derive(Clone, Debug)]
pub struct Leaf {
    pub epoch: u32,
    pub index: u32,
    pub exp: u8,
    pub nullifier: [u8; 32],
    pub trapdoor: [u8; 32],
}

impl Leaf {
    pub fn inner(&self) -> [u8; 32] {
        hash(&[&self.nullifier, &self.trapdoor])
    }

    pub fn nullifier_hash(&self, scope: &[u8; 32]) -> [u8; 32] {
        hash(&[&self.nullifier, scope])
    }
}

/// A recipient: an owner that holds no SOL and its token account of the reward mint.
#[derive(Clone, Copy, Debug)]
pub struct Wallet {
    pub owner: Pubkey,
    pub token: Pubkey,
}

#[derive(Default)]
pub struct State {
    pub tree_leaves: Vec<(u32, [u8; 32])>,
    counter: u32,
    locks: Vec<Pubkey>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Which {
    Current,
    Previous,
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

fn store(which: Which) -> &'static HashMap<String, [u8; 128]> {
    static CURRENT: OnceLock<HashMap<String, [u8; 128]>> = OnceLock::new();
    static PREVIOUS: OnceLock<HashMap<String, [u8; 128]>> = OnceLock::new();
    let (cell, text) = match which {
        Which::Current => (
            &CURRENT,
            include_str!("../fixtures/claim_proofs_current.json"),
        ),
        Which::Previous => (
            &PREVIOUS,
            include_str!("../fixtures/claim_proofs_previous.json"),
        ),
    };
    cell.get_or_init(|| {
        let stored: Stored = serde_json::from_str(text).expect("claim fixtures");
        stored
            .claims
            .into_iter()
            .map(|p| {
                let proof = hex::decode(p.compressed).unwrap().try_into().unwrap();
                (p.key, proof)
            })
            .collect()
    })
}

static RECORDED: Mutex<Vec<(Which, String, serde_json::Value)>> = Mutex::new(Vec::new());

fn record(which: Which, key: &str, request: &Request) {
    let Ok(dir) = std::env::var("CLAIM_RECORD") else {
        panic!("no proof for claim {key} under {which:?}: run scripts/prove-claim-fixtures.sh");
    };
    let mut recorded = RECORDED.lock().unwrap();
    if recorded.iter().any(|(w, k, _)| *w == which && k == key) {
        return;
    }
    recorded.push((
        which,
        key.to_owned(),
        serde_json::to_value(request).unwrap(),
    ));
    let name = format!("{which:?}").to_lowercase();
    let all: Vec<&serde_json::Value> = recorded
        .iter()
        .filter(|(w, _, _)| *w == which)
        .map(|(_, _, v)| v)
        .collect();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        format!("{dir}/requests_{name}.json"),
        serde_json::to_string(&all).unwrap(),
    )
    .unwrap();
}

fn word(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(bytes);
    out
}

/// One `claim_rewards` transaction, with every field a test may alter.
#[derive(Clone)]
pub struct Claim {
    pub claims: Vec<OneClaim>,
    pub recipient: Pubkey,
    pub owner: Pubkey,
    pub max_fee: u64,
    pub vk_sha256: [u8; 32],
}

impl Claim {
    pub fn recipient_wallet(mut self, wallet: &Wallet) -> Self {
        self.recipient = wallet.token;
        self.owner = wallet.owner;
        self
    }

    pub fn with_previous_vk(mut self) -> Self {
        self.vk_sha256 = *vk::CLAIM_PREVIOUS.expect("test keys").sha256;
        self
    }
}

/// How a claim is proved: the key it is proved under, the scope and the root it binds.
#[derive(Clone, Copy)]
pub struct Proving {
    pub which: Which,
    pub scope: Option<[u8; 32]>,
    /// A leaf to put in the claimed slot of a local copy of the tree, whose root the claim then opens.
    pub forged: Option<[u8; 32]>,
}

impl Proving {
    pub const CURRENT: Self = Self {
        which: Which::Current,
        scope: None,
        forged: None,
    };
}

/// The root of a tree of depth 20 holding `leaves`, empty subtrees as in the program.
pub fn tree_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    let mut level = leaves.to_vec();
    let mut zero = [0u8; 32];
    for _ in 0..buckspay::TREE_DEPTH {
        if level.len() % 2 == 1 {
            level.push(zero);
        }
        level = level.chunks(2).map(|p| hash(&[&p[0], &p[1]])).collect();
        zero = hash(&[&zero, &zero]);
    }
    level[0]
}

#[derive(Deserialize)]
pub struct Derivation {
    pub exp: u8,
    #[serde(deserialize_with = "hex32")]
    pub inner: [u8; 32],
    #[serde(deserialize_with = "hex32")]
    pub leaf: [u8; 32],
}

fn hex32<'de, D: serde::Deserializer<'de>>(d: D) -> Result<[u8; 32], D::Error> {
    let text = String::deserialize(d)?;
    hex::decode(text)
        .map_err(serde::de::Error::custom)?
        .try_into()
        .map_err(|_| serde::de::Error::custom("32 bytes"))
}

/// The leaf derivations of the claim circuit's test vectors, as the Go side computed them.
pub fn go_derivations() -> Vec<Derivation> {
    #[derive(Deserialize)]
    struct Vectors {
        derivations: Vec<Derivation>,
    }
    let vectors: Vectors = serde_json::from_str(include_str!(
        "../../../../../prover/testdata/claim-vectors.json"
    ))
    .expect("claim vectors");
    vectors.derivations
}

impl ChannelEnv {
    pub fn claim_fee(&self) -> u64 {
        self.policy().claim_fee
    }

    pub fn max_fee(&self) -> u64 {
        self.policy().max_fee
    }

    fn secret(&mut self, label: &str) -> [u8; 32] {
        self.claims.counter += 1;
        let n = self.claims.counter.to_le_bytes();
        fr::reduce(&content(
            &[b"buckspay/test/claim/", label.as_bytes(), &n].concat(),
        ))
    }

    pub fn current_epoch(&self) -> u32 {
        self.reward_mint_account().epoch
    }

    /// A recipient the program never saw: no lamports, a token account of the reward mint.
    pub fn fresh_wallet_with_zero_sol(&mut self) -> Wallet {
        self.claims.counter += 1;
        let n = self.claims.counter.to_le_bytes();
        let owner = Pubkey::new_from_array(content(&[b"buckspay/test/wallet/", &n[..]].concat()));
        let token = self.env.token_account_of(&owner, 0);
        Wallet { owner, token }
    }

    fn settle_for(&mut self, words: u16, inners: &[[u8; 32]]) -> Result<Landed, Refused> {
        let depth = if words > 16 { 8 } else { 4 };
        let c = self.payer_channel(depth);
        self.claims.locks.push(c.issuer.lock);
        let indexes: Vec<u16> = (0..words).collect();
        let s = Settle::new().first(&c, &indexes).inners_with(inners);
        self.send(s)
    }

    /// Settles `2^exp` words of a fresh channel: one leaf of `exp` whose secrets the test knows.
    pub fn settled_leaf(&mut self, exp: u8) -> Leaf {
        let mut leaf = Leaf {
            epoch: self.current_epoch(),
            index: 0,
            exp,
            nullifier: self.secret("nullifier"),
            trapdoor: self.secret("trapdoor"),
        };
        self.settle_for(1 << exp, &[leaf.inner()])
            .unwrap_or_else(|e| panic!("{e:?}"));
        let (index, _) = self.leaf_events()[0];
        leaf.index = index;
        leaf
    }

    /// The compute units of settling `words` of a fresh channel.
    pub fn settle_words_measured(&mut self, words: u16) -> u64 {
        self.settle_words_result(words)
            .unwrap_or_else(|e| panic!("{words} words: {e:?}"))
            .units
    }

    /// Settles `words` of a fresh channel into the leaves of `canonical_exps(words)`.
    pub fn settle_words(&mut self, words: u16) {
        self.settle_words_result(words)
            .unwrap_or_else(|e| panic!("{e:?}"));
    }

    pub fn settle_words_err(&mut self, words: u16) -> Refused {
        self.settle_words_result(words).unwrap_err()
    }

    fn settle_words_result(&mut self, words: u16) -> Result<Landed, Refused> {
        let count = buckspay_protocol::payword::canonical_exps(u32::from(words))
            .map_or(0, |exps| exps.len());
        let inners: Vec<[u8; 32]> = (0..count)
            .map(|_| {
                let (n, t) = (self.secret("nullifier"), self.secret("trapdoor"));
                hash(&[&n, &t])
            })
            .collect();
        self.settle_for(words, &inners)
    }

    /// `batches` transactions of two words each, one root pushed by every one of them.
    pub fn settle_dummy_batches(&mut self, batches: usize) {
        let mut channels = vec![];
        for k in 0..batches {
            if k % 128 == 0 {
                let c = self.payer_channel(8);
                self.claims.locks.push(c.issuer.lock);
                channels.push(c);
            }
            let c = channels.last().unwrap();
            let at = (2 * (k % 128)) as u16;
            let (n, t) = (self.secret("nullifier"), self.secret("trapdoor"));
            let s = if k % 128 == 0 {
                Settle::new().first(c, &[at, at + 1])
            } else {
                Settle::new().again(c, &[at, at + 1])
            };
            self.send(s.inners_with(&[hash(&[&n, &t])]))
                .unwrap_or_else(|e| panic!("{e:?}"));
        }
    }

    pub fn tree_account(&self, epoch: u32) -> RewardTree {
        read_tree(&self.env, &reward_tree_address(&self.env.mint, epoch))
    }

    pub fn latest_root_of(&self, epoch: u32) -> [u8; 32] {
        let tree = self.tree_account(epoch);
        tree.roots[(tree.root_index as usize + buckspay::ROOT_HISTORY - 1) % buckspay::ROOT_HISTORY]
    }

    /// A root the tree knows that is not its latest.
    pub fn other_known_root(&self, epoch: u32) -> [u8; 32] {
        let tree = self.tree_account(epoch);
        let latest = self.latest_root_of(epoch);
        *tree
            .roots
            .iter()
            .find(|r| **r != [0u8; 32] && **r != latest)
            .expect("two roots")
    }

    pub fn scope(&self) -> [u8; 32] {
        buckspay::reward_scope(&self.env.mint)
    }

    fn proof_for(
        &self,
        leaf: &Leaf,
        owner: &Pubkey,
        max_fee: u64,
        proving: Proving,
    ) -> ([u8; 32], [u8; 32], [u8; 128]) {
        let scope = proving.scope.unwrap_or_else(|| self.scope());
        let mut leaves: Vec<[u8; 32]> = self
            .claims
            .tree_leaves
            .iter()
            .filter(|(epoch, _)| *epoch == leaf.epoch)
            .map(|(_, l)| *l)
            .collect();
        let root = match proving.forged {
            Some(forged) => {
                leaves[leaf.index as usize] = forged;
                tree_root(&leaves)
            }
            None => self.latest_root_of(leaf.epoch),
        };
        let nullifier_hash = leaf.nullifier_hash(&scope);
        let key: String = [
            root,
            nullifier_hash,
            scope,
            word(&owner.to_bytes()[..16]),
            word(&owner.to_bytes()[16..]),
            word(&[leaf.exp]),
            word(&max_fee.to_be_bytes()),
        ]
        .iter()
        .map(hex::encode)
        .collect();
        let proof = store(proving.which).get(&key).copied().unwrap_or_else(|| {
            let leaves = leaves.iter().map(hex::encode).collect();
            record(
                proving.which,
                &key,
                &Request {
                    leaves,
                    index: leaf.index,
                    nullifier: hex::encode(leaf.nullifier),
                    trapdoor: hex::encode(leaf.trapdoor),
                    exp: leaf.exp,
                    scope: hex::encode(scope),
                    recipient: hex::encode(owner),
                    max_fee,
                },
            );
            [0u8; 128]
        });
        (root, nullifier_hash, proof)
    }

    pub fn claim_of(
        &self,
        leaves: &[Leaf],
        wallet: &Wallet,
        max_fee: u64,
        proving: Proving,
    ) -> Claim {
        let claims = leaves
            .iter()
            .map(|leaf| {
                let (root, nullifier_hash, proof) =
                    self.proof_for(leaf, &wallet.owner, max_fee, proving);
                OneClaim {
                    epoch: leaf.epoch,
                    root,
                    nullifier_hash,
                    exp: leaf.exp,
                    proof,
                }
            })
            .collect();
        let key = match proving.which {
            Which::Current => vk::CLAIM.sha256,
            Which::Previous => vk::CLAIM_PREVIOUS.expect("test keys").sha256,
        };
        Claim {
            claims,
            recipient: wallet.token,
            owner: wallet.owner,
            max_fee,
            vk_sha256: *key,
        }
    }

    pub fn claim_one(&self, leaf: &Leaf, wallet: &Wallet, max_fee: u64) -> Claim {
        self.claim_of(
            std::slice::from_ref(leaf),
            wallet,
            max_fee,
            Proving::CURRENT,
        )
    }

    /// A claim of `leaf` as if the program had appended it with `exp`: the proof opens a local tree
    /// that holds that leaf, so its root is one the program never pushed.
    pub fn claim_forged(&self, leaf: &Leaf, exp: u8, wallet: &Wallet, max_fee: u64) -> Claim {
        let forged = Leaf {
            exp,
            ..leaf.clone()
        };
        let proving = Proving {
            forged: Some(poseidon2(&leaf.inner(), exp)),
            ..Proving::CURRENT
        };
        self.claim_of(&[forged], wallet, max_fee, proving)
    }

    pub fn claim_many(&self, leaves: &[Leaf], wallet: &Wallet, max_fee: u64) -> Claim {
        self.claim_of(leaves, wallet, max_fee, Proving::CURRENT)
    }

    pub fn nullifier_address(&self, nullifier_hash: &[u8; 32]) -> Pubkey {
        Pubkey::find_program_address(
            &[NULLIFIER_SEED, self.env.mint.as_ref(), nullifier_hash],
            &buckspay::ID,
        )
        .0
    }

    pub fn nullifier_exists(&self, leaf: &Leaf) -> bool {
        let address = self.nullifier_address(&leaf.nullifier_hash(&self.scope()));
        self.env.svm.get_account(&address).is_some()
    }

    pub fn claim_ix(&self, c: &Claim) -> Instruction {
        let mut accounts = buckspay::accounts::ClaimRewards {
            payer: self.gateway(),
            reward_config: reward_config_address(),
            reward_mint: self.reward_mint,
            pool_ledger: self.pool_ledger,
            pool_escrow: self.pool_escrow,
            fee_account: self.fee_account,
            recipient: c.recipient,
            mint: self.env.mint,
            token_program: self.env.token_program,
            system_program: system_program::ID,
        }
        .to_account_metas(None);
        for claim in &c.claims {
            accounts.push(AccountMeta::new_readonly(
                reward_tree_address(&self.env.mint, claim.epoch),
                false,
            ));
            accounts.push(AccountMeta::new(
                self.nullifier_address(&claim.nullifier_hash),
                false,
            ));
        }
        Instruction {
            program_id: buckspay::ID,
            accounts,
            data: buckspay::instruction::ClaimRewards {
                args: ClaimArgs {
                    vk_sha256: c.vk_sha256,
                    max_fee: c.max_fee,
                    claims: c.claims.clone(),
                },
            }
            .data(),
        }
    }

    pub fn claim(&mut self, c: &Claim) -> Result<Landed, Refused> {
        let ix = self.claim_ix(c);
        let landed = self.env.send_v1(&[ix]).map_err(Refused)?;
        self.last_logs = self.env.logs().lines().map(str::to_owned).collect();
        self.refresh();
        Ok(landed)
    }

    pub fn fee_account_balance(&self) -> u64 {
        self.env.balance(&self.fee_account)
    }

    /// Settles `2^exp` words into one leaf of the given inner; returns its `(epoch, index)`.
    pub fn settle_inner(&mut self, exp: u8, inner: [u8; 32]) -> (u32, u32) {
        let epoch = self.current_epoch();
        self.settle_for(1 << exp, &[inner])
            .unwrap_or_else(|e| panic!("{e:?}"));
        (epoch, self.leaf_events()[0].0)
    }

    pub fn wallet_balance(&self, wallet: &Wallet) -> u64 {
        self.token_balance(wallet.token)
    }

    pub fn reward_config(&self) -> RewardConfig {
        self.env.account(&reward_config_address())
    }

    pub fn edit_reward_config(&mut self, f: impl FnOnce(&mut RewardConfig)) {
        let mut config = self.reward_config();
        f(&mut config);
        let mut data = vec![];
        config.try_serialize(&mut data).unwrap();
        let mut account = self.env.svm.get_account(&reward_config_address()).unwrap();
        account.data = data;
        self.env.set_account(reward_config_address(), account);
    }

    /// The configuration as it is before a rotation: the previous claim key is the current one.
    pub fn before_claim_key_rotation(&mut self) {
        let previous = *vk::CLAIM_PREVIOUS.expect("test keys").sha256;
        self.edit_reward_config(|c| c.claim_key = super::super::zk::key_hashes(&previous));
    }

    pub fn rotate_claim_vk(
        &mut self,
        signer: &Keypair,
        keep_previous: bool,
    ) -> Result<i64, Refused> {
        let ix = self.reward_admin_ix(
            &signer.pubkey(),
            buckspay::instruction::RotateClaimVk {
                next: super::super::zk::key_hashes(vk::CLAIM.sha256),
                keep_previous,
            }
            .data(),
        );
        self.env.send(signer, &[ix]).map_err(Refused)?;
        Ok(self.reward_config().rotated_at)
    }

    pub fn revoke_previous_claim_vk(&mut self, signer: &Keypair) -> Result<Landed, Refused> {
        let ix = self.reward_admin_ix(
            &signer.pubkey(),
            buckspay::instruction::RevokePreviousClaimVk {}.data(),
        );
        self.env.send(signer, &[ix]).map_err(Refused)
    }

    fn reward_admin_ix(&self, signer: &Pubkey, data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: buckspay::ID,
            accounts: buckspay::accounts::RewardAdmin {
                signer: *signer,
                reward_config: reward_config_address(),
            }
            .to_account_metas(None),
            data,
        }
    }

    pub fn set_claim_policy(&mut self, claim_fee: u64, claim_cap: u64) {
        let admin = self.admin.insecure_clone();
        let ix = self.set_policy_ix(&admin.pubkey(), claim_fee, self.fee_account, claim_cap);
        self.env.send(&admin, &[ix]).unwrap();
        self.refresh();
    }

    pub fn lock_accounts_digest(&self) -> Vec<Option<Vec<u8>>> {
        let addresses: Vec<Pubkey> = self
            .claims
            .locks
            .iter()
            .flat_map(|lock| [*lock, ledger_address(lock), escrow_address(lock)])
            .collect();
        self.env.digest(&addresses)
    }

    pub fn pool_is_solvent(&self) -> bool {
        let ledger: buckspay::Ledger = self.env.account(&self.pool_ledger);
        ledger.backing_left == self.env.balance(&self.pool_escrow)
    }

    pub fn tree_leaf(&self, epoch: u32, index: u32) -> [u8; 32] {
        self.claims
            .tree_leaves
            .iter()
            .filter(|(e, _)| *e == epoch)
            .map(|(_, l)| *l)
            .nth(index as usize)
            .expect("a leaf")
    }
}
