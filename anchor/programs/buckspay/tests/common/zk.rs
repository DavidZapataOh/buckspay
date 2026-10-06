//! Private settlement in the harness: a cluster's feature set, the configuration of the program,
//! notes with their proofs and the builders of every instruction of the private path.
//!
//! The proofs are made by `buckspay-zk prove-batch` and kept in `tests/fixtures`. A note whose
//! proofs are missing is written to the directory named by `ZK_RECORD` and the test stops.
use super::{claims::*, *};
use agave_feature_set::FeatureSet;
use anchor_lang::{
    solana_program::instruction::AccountMeta, AccountSerialize, InstructionData, ToAccountMetas,
};
use buckspay::{KeyHashes, WireMessage, ZkConfig};
use buckspay_protocol::{chain, hash::content, Caveats, Outputs, Owner, Spend};
use buckspay_zk_verify::{vk, PROOF_COMPRESSED};
use serde::Deserialize;
use std::{collections::HashMap, str::FromStr, sync::OnceLock};

pub const R_BYTES: [u8; 32] = buckspay_zk_verify::fr::MODULUS;
const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

#[derive(Clone, Copy, Debug)]
pub enum Cluster {
    Devnet,
    Mainnet,
}

impl Cluster {
    fn name(self) -> &'static str {
        match self {
            Cluster::Devnet => "devnet",
            Cluster::Mainnet => "mainnet",
        }
    }

    /// The features active on the cluster, from the dump of its feature accounts. Every feature
    /// of the pinned feature crate must be in the dump, active or not.
    pub fn feature_set(self) -> FeatureSet {
        let path = format!("{FIXTURES}/features-{}.txt", self.name());
        let text = std::fs::read_to_string(path).expect("feature dump");
        let mut set = FeatureSet::default();
        let mut listed = std::collections::HashSet::new();
        for line in text.lines() {
            let mut fields = line.split_whitespace();
            let id = Pubkey::from_str(fields.next().unwrap()).unwrap();
            listed.insert(id);
            if let Ok(slot) = fields.next().unwrap().parse() {
                set.activate(&id, slot);
            }
        }
        for id in agave_feature_set::FEATURE_NAMES.keys() {
            assert!(listed.contains(id), "the dump misses feature {id}");
        }
        set
    }

    pub fn svm(self) -> LiteSVM {
        LiteSVM::default()
            .with_feature_set(self.feature_set())
            .with_builtins()
            .with_lamports(1_000_000u64.wrapping_mul(1_000_000_000))
            .with_sysvars()
            .with_feature_accounts()
            .with_default_programs()
            .with_sigverify(true)
            .with_blockhash_check(true)
            .with_precompiles()
    }
}

#[derive(Deserialize)]
struct ProofsFile {
    vk_sha256: String,
    cases: Vec<CaseFile>,
}

#[derive(Deserialize)]
struct CaseFile {
    name: String,
    proofs: Vec<ProofFile>,
}

#[derive(Deserialize)]
struct ProofFile {
    compressed: String,
    public: Vec<String>,
}

#[derive(Clone, Copy)]
struct Proved {
    proof: [u8; PROOF_COMPRESSED],
    s_out: [u8; 32],
}

/// Which verifying key a note is proved under.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Key2 {
    Current,
    Previous,
}

struct Store {
    cases: HashMap<String, Vec<Proved>>,
}

fn store(which: Key2) -> &'static Store {
    static CURRENT: OnceLock<Store> = OnceLock::new();
    static PREVIOUS: OnceLock<Store> = OnceLock::new();
    let (cell, file, vk_hash) = match which {
        Key2::Current => (&CURRENT, "zk_proofs_current.json", *vk::VK.sha256),
        Key2::Previous => (
            &PREVIOUS,
            "zk_proofs_previous.json",
            *vk::PREVIOUS.expect("test keys").sha256,
        ),
    };
    cell.get_or_init(|| {
        let Ok(text) = std::fs::read_to_string(format!("{FIXTURES}/{file}")) else {
            return Store {
                cases: HashMap::new(),
            };
        };
        let file: ProofsFile = serde_json::from_str(&text).expect("proof fixtures");
        assert_eq!(
            file.vk_sha256,
            hex::encode(vk_hash),
            "fixtures of another key"
        );
        let cases = file
            .cases
            .into_iter()
            .map(|case| {
                let proved = case
                    .proofs
                    .iter()
                    .map(|p| Proved {
                        proof: hex::decode(&p.compressed).unwrap().try_into().unwrap(),
                        s_out: hex::decode(&p.public[4]).unwrap().try_into().unwrap(),
                    })
                    .collect();
                (case.name, proved)
            })
            .collect();
        Store { cases }
    })
}

/// The test double of `serde_json` for the scenarios the prover reads.
fn scenario(name: &str, chain: &Chain) -> String {
    let domain = buckspay::note_domain();
    let messages: Vec<String> = chain
        .signed
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let body = if i == 0 {
                chain.issue_body.to_vec()
            } else {
                chain.links[i - 1].body.clone()
            };
            format!(
                r#"{{"kind":{},"body":"{}","sig_r":"{}","sig_s":"{}","key":"{}"}}"#,
                body[1],
                hex::encode(&body),
                hex::encode(&s.signature[..32]),
                hex::encode(&s.signature[32..]),
                hex::encode(s.key)
            )
        })
        .collect();
    let mut openings = vec![format!(
        r#"{{"owner":"{}","amount":0,"caveats":"{}","salt":"{}","index":0}}"#,
        hex::encode([0u8; 33]),
        hex::encode([0u8; 27]),
        hex::encode([0u8; 16])
    )];
    for (index, link) in chain.links.iter().enumerate() {
        let holding = chain.holding_before(index);
        let input = if link.input == 0 {
            holding.first
        } else {
            holding.second.unwrap()
        };
        let salt = if index == 0 {
            chain.issue.salt
        } else {
            let before = chain.holding_before(index - 1);
            let prior = if chain.links[index - 1].input == 0 {
                before.first
            } else {
                before.second.unwrap()
            };
            Spend::decode(prior.id, &chain.links[index - 1].body)
                .unwrap()
                .salt
        };
        openings.push(format!(
            r#"{{"owner":"{}","amount":{},"caveats":"{}","salt":"{}","index":{}}}"#,
            hex::encode(input.owner.encode()),
            input.amount,
            hex::encode(input.caveats.encode()),
            hex::encode(salt),
            link.input
        ));
    }
    format!(
        r#"{{"domain":"{}","valid":[{{"name":"{name}","messages":[{}],"openings":[{}],"message_ids":[],"output_ids":[],"public":[]}}],"invalid":[]}}"#,
        hex::encode(domain),
        messages.join(","),
        openings.join(",")
    )
}

fn scenario_name(chain: &Chain) -> String {
    let mut bytes = buckspay::note_domain().to_vec();
    bytes.extend_from_slice(&chain.issue_body);
    for link in &chain.links {
        bytes.push(link.input);
        bytes.extend_from_slice(&link.body);
    }
    hex::encode(content(&bytes))
}

/// A note ready to settle privately: the chain, its messages with their proofs and what the
/// settlement names.
#[derive(Clone)]
pub struct Note {
    pub chain: Chain,
    pub wire: Vec<WireMessage>,
    pub vk_sha256: [u8; 32],
    pub payee: Pubkey,
    pub payee_ata: Pubkey,
    pub issuer_key: [u8; 33],
    pub lock_seq: u32,
    pub lock: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub cum_end: u64,
    pub pay_amount: u64,
    pub expiry: u32,
    pub lock_until: u32,
}

impl Note {
    /// The outputs the settlement records and the content of the message that consumed each.
    pub fn consumed(&self) -> Vec<([u8; 32], [u8; 32])> {
        consumed_outputs(&self.chain)
            .into_iter()
            .zip(self.chain.links.iter().map(|l| content(&l.body)))
            .collect()
    }
}

pub struct MintPolicy {
    pub global_cap: u64,
    pub lock_cap: u64,
    pub record_fee: u64,
}

impl MintPolicy {
    /// Caps above every amount the tests move and no fee.
    pub fn test() -> Self {
        Self {
            global_cap: 1_000_000_000_000,
            lock_cap: 100_000_000_000,
            record_fee: 0,
        }
    }
}

/// The error of a transaction and the compute units it spent before failing.
#[derive(Debug)]
pub struct Failed {
    pub error: TransactionError,
    pub cu: u64,
}

impl Failed {
    pub fn custom(&self) -> u32 {
        match &self.error {
            TransactionError::InstructionError(_, InstructionError::Custom(code)) => *code,
            other => panic!("not a program error: {other:?}"),
        }
    }
}

pub fn code_of(error: buckspay::BuckspayError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + error as u32
}

pub fn zk_config_address() -> Pubkey {
    Pubkey::find_program_address(&[buckspay::zk::ZK_CONFIG_SEED], &buckspay::ID).0
}

pub fn zk_mint_address(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[buckspay::zk::ZK_MINT_SEED, mint.as_ref()], &buckspay::ID).0
}

pub fn draws_address(lock: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[buckspay::zk::ZK_DRAWS_SEED, lock.as_ref()], &buckspay::ID).0
}

pub fn buffer_address(payer: &Pubkey, nonce: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[
            buckspay::zk::PROOF_BUFFER_SEED,
            payer.as_ref(),
            &nonce.to_le_bytes(),
        ],
        &buckspay::ID,
    )
    .0
}

fn program_data_address() -> Pubkey {
    Pubkey::find_program_address(
        &[buckspay::ID.as_ref()],
        &anchor_lang::solana_program::bpf_loader_upgradeable::id(),
    )
    .0
}

pub fn key_hashes(sha: &[u8; 32]) -> KeyHashes {
    KeyHashes {
        vk: *sha,
        pk: [1; 32],
        dump: [2; 32],
        ccs: [3; 32],
    }
}

/// One `settle_chain_proof` instruction, with every field a test may alter.
#[derive(Clone)]
pub struct ZkSettle {
    pub vk_sha256: [u8; 32],
    pub issuer_key: [u8; 33],
    pub lock_seq: u32,
    pub amount: u64,
    pub cum_end: u64,
    pub pay_amount: u64,
    pub expiry: u32,
    pub messages: Vec<WireMessage>,
    pub lock: Pubkey,
    pub mint: Pubkey,
    pub payee_ata: Pubkey,
    pub fee_account: Pubkey,
    pub buffer: Option<Pubkey>,
    pub records: Vec<Pubkey>,
}

impl ZkSettle {
    pub fn inline(z: &Zk, note: &Note) -> Self {
        Self {
            vk_sha256: note.vk_sha256,
            issuer_key: note.issuer_key,
            lock_seq: note.lock_seq,
            amount: note.amount,
            cum_end: note.cum_end,
            pay_amount: note.pay_amount,
            expiry: note.expiry,
            messages: note.wire.clone(),
            lock: note.lock,
            mint: note.mint,
            payee_ata: note.payee_ata,
            fee_account: z.fee_account,
            buffer: None,
            records: note
                .consumed()
                .iter()
                .map(|(o, _)| record_account(o))
                .collect(),
        }
    }

    pub fn from_buffer(z: &Zk, note: &Note, buffer: Pubkey) -> Self {
        Self {
            messages: vec![],
            buffer: Some(buffer),
            ..Self::inline(z, note)
        }
    }

    pub fn ix(&self, payer: &Pubkey) -> Instruction {
        let mut accounts = buckspay::accounts::SettleChainProof {
            payer: *payer,
            config: zk_config_address(),
            zk_mint: zk_mint_address(&self.mint),
            lock: self.lock,
            ledger: ledger_address(&self.lock),
            escrow: escrow_address(&self.lock),
            mint: self.mint,
            destination: self.payee_ata,
            fee_account: self.fee_account,
            draws: draws_address(&self.lock),
            buffer: self.buffer,
            token_program: token_id(),
            system_program: system_program::ID,
        }
        .to_account_metas(None);
        accounts.extend(self.records.iter().map(|r| AccountMeta::new(*r, false)));
        Instruction {
            program_id: buckspay::ID,
            accounts,
            data: buckspay::instruction::SettleChainProof {
                vk_sha256: self.vk_sha256,
                issuer_key: self.issuer_key,
                lock_seq: self.lock_seq,
                amount: self.amount,
                cum_end: self.cum_end,
                pay_amount: self.pay_amount,
                expiry: self.expiry,
                messages: self.messages.clone(),
            }
            .data(),
        }
    }
}

/// The harness of private settlement on one cluster.
pub struct Zk {
    pub w: World,
    pub cluster: Cluster,
    /// Holds the upgrade authority of the program.
    pub authority: Keypair,
    pub admin: Keypair,
    pub pauser: Keypair,
    pub stranger: Keypair,
    pub fee_account: Pubkey,
    pub payee_b: Pubkey,
    pub payee_b_ata: Pubkey,
}

impl Zk {
    pub fn new(cluster: Cluster) -> Self {
        let mut z = Self::bare(cluster);
        z.init_config(&key_hashes(vk::VK.sha256));
        z.set_mint_policy_as_admin(MintPolicy::test());
        z
    }

    /// The environment before the configuration of private settlement exists.
    pub fn bare(cluster: Cluster) -> Self {
        let env = Env::new_on(cluster.svm(), MintSetup::classic());
        let mut w = world_in(env, 10);
        let fee_account = w
            .env
            .token_account_of(&Pubkey::new_from_array([0x66; 32]), 0);
        let payee_b = Pubkey::new_from_array([0x78; 32]);
        let payee_b_ata = w.env.token_account_of(&payee_b, 0);
        let mut z = Self {
            w,
            cluster,
            authority: Keypair::new(),
            admin: Keypair::new(),
            pauser: Keypair::new(),
            stranger: Keypair::new(),
            fee_account,
            payee_b,
            payee_b_ata,
        };
        for k in [&z.authority, &z.admin, &z.pauser, &z.stranger] {
            z.w.env.svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        }
        z.install_upgradeable_program();
        z
    }

    /// Gives the program's data account the upgrade authority `self.authority`: the harness loads
    /// the program as upgradeable with no authority.
    fn install_upgradeable_program(&mut self) {
        let mut data = self.w.env.svm.get_account(&program_data_address()).unwrap();
        data.data[12] = 1;
        data.data[13..45].copy_from_slice(self.authority.pubkey().as_ref());
        self.w.env.set_account(program_data_address(), data);
    }

    pub fn env(&mut self) -> &mut Env {
        &mut self.w.env
    }

    pub fn gateway(&self) -> Pubkey {
        self.w.env.payer.pubkey()
    }

    /// Sends one instruction as a v1 transaction paid by the gateway.
    pub fn send_ix(&mut self, ix: Instruction) -> Result<Landed, Failed> {
        self.send_ixs(&[ix])
    }

    pub fn send_ixs(&mut self, ixs: &[Instruction]) -> Result<Landed, Failed> {
        match self.w.env.send_v1(ixs) {
            Ok(landed) => Ok(landed),
            Err(error) => {
                let (_, cu) = self.w.env.failed_v1(ixs);
                Err(Failed { error, cu })
            }
        }
    }

    pub fn send(&mut self, s: &ZkSettle) -> Result<Landed, Failed> {
        let payer = self.gateway();
        self.send_ix(s.ix(&payer))
    }

    /// Sends an instruction signed by `signer`, who also pays.
    pub fn send_as(&mut self, signer: &Keypair, ix: Instruction) -> Result<Landed, Failed> {
        match self.w.env.send(signer, std::slice::from_ref(&ix)) {
            Ok(landed) => Ok(landed),
            Err(error) => Err(Failed { error, cu: 0 }),
        }
    }

    pub fn init_config(&mut self, current: &KeyHashes) {
        let ix = self.init_config_ix(&self.authority.pubkey(), current);
        let authority = self.authority.insecure_clone();
        self.send_as(&authority, ix).unwrap();
    }

    pub fn init_config_ix(&self, signer: &Pubkey, current: &KeyHashes) -> Instruction {
        Instruction {
            program_id: buckspay::ID,
            accounts: buckspay::accounts::InitZkConfig {
                authority: *signer,
                config: zk_config_address(),
                program: buckspay::ID,
                program_data: program_data_address(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: buckspay::instruction::InitZkConfig {
                admin: self.admin.pubkey(),
                pauser: self.pauser.pubkey(),
                current: *current,
            }
            .data(),
        }
    }

    pub fn config(&self) -> ZkConfig {
        self.w.env.account(&zk_config_address())
    }

    pub fn edit_config(&mut self, f: impl FnOnce(&mut ZkConfig)) {
        let mut config = self.config();
        f(&mut config);
        let mut data = vec![];
        config.try_serialize(&mut data).unwrap();
        let mut account = self.w.env.svm.get_account(&zk_config_address()).unwrap();
        account.data = data;
        self.w.env.set_account(zk_config_address(), account);
    }

    fn admin_ix(&self, signer: &Pubkey, data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: buckspay::ID,
            accounts: buckspay::accounts::ZkAdmin {
                signer: *signer,
                config: zk_config_address(),
            }
            .to_account_metas(None),
            data,
        }
    }

    pub fn set_paused(&mut self, signer: &Keypair, paused: bool) -> Result<Landed, Failed> {
        let ix = self.admin_ix(
            &signer.pubkey(),
            buckspay::instruction::SetZkPaused { paused }.data(),
        );
        self.send_as(signer, ix)
    }

    pub fn set_mint_policy(
        &mut self,
        signer: &Keypair,
        policy: MintPolicy,
    ) -> Result<Landed, Failed> {
        let mint = self.w.env.mint;
        let ix = Instruction {
            program_id: buckspay::ID,
            accounts: buckspay::accounts::SetZkMint {
                admin: signer.pubkey(),
                config: zk_config_address(),
                mint,
                zk_mint: zk_mint_address(&mint),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: buckspay::instruction::SetZkMint {
                global_cap: policy.global_cap,
                lock_cap: policy.lock_cap,
                record_fee: policy.record_fee,
                fee_account: self.fee_account,
            }
            .data(),
        };
        self.send_as(signer, ix)
    }

    fn set_mint_policy_as_admin(&mut self, policy: MintPolicy) {
        let admin = self.admin.insecure_clone();
        self.set_mint_policy(&admin, policy).unwrap();
    }

    pub fn rotate_vk(&mut self, signer: &Keypair, keep_previous: bool) -> Result<i64, Failed> {
        let ix = self.admin_ix(
            &signer.pubkey(),
            buckspay::instruction::RotateVk {
                next: key_hashes(vk::VK.sha256),
                keep_previous,
            }
            .data(),
        );
        self.send_as(signer, ix)?;
        Ok(self.config().rotated_at)
    }

    pub fn revoke_previous_vk(&mut self, signer: &Keypair) -> Result<Landed, Failed> {
        let ix = self.admin_ix(
            &signer.pubkey(),
            buckspay::instruction::RevokePreviousVk {}.data(),
        );
        self.send_as(signer, ix)
    }

    pub fn set_authorities(
        &mut self,
        signer: &Keypair,
        admin: Pubkey,
        pauser: Pubkey,
    ) -> Result<Landed, Failed> {
        let ix = self.admin_ix(
            &signer.pubkey(),
            buckspay::instruction::SetZkAuthorities { admin, pauser }.data(),
        );
        self.send_as(signer, ix)
    }

    /// The configuration as it stands after a program upgrade that replaced the key
    /// `previous`: the config still names that key as current.
    pub fn before_rotation(&mut self) {
        let previous = *vk::PREVIOUS.expect("test keys").sha256;
        self.edit_config(|c| c.current = key_hashes(&previous));
    }

    // Notes.

    fn proved(
        &self,
        which: Key2,
        chain: Chain,
        payee: Pubkey,
        payee_ata: Pubkey,
        lock: &Issuer,
    ) -> Note {
        let name = scenario_name(&chain);
        let found = store(which).cases.get(&name);
        let missing: Vec<Proved>;
        let proved = match found {
            Some(proved) => proved,
            None => {
                let Ok(dir) = std::env::var("ZK_RECORD") else {
                    panic!("no proofs for note {name} under {which:?}: run scripts/prove-zk-fixtures.sh");
                };
                let dir = format!("{dir}/{which:?}");
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(format!("{dir}/{name}.json"), scenario(&name, &chain)).unwrap();
                missing = vec![
                    Proved {
                        proof: [0; PROOF_COMPRESSED],
                        s_out: [0; 32]
                    };
                    chain.signed.len()
                ];
                &missing
            }
        };
        let mut bodies = vec![chain.issue_body.to_vec()];
        bodies.extend(chain.links.iter().map(|l| l.body.clone()));
        let wire = bodies
            .iter()
            .enumerate()
            .map(|(i, body)| WireMessage {
                content: content(body),
                next_bit: chain.links.get(i).map_or(0, |l| l.input),
                s_out: if i + 1 == bodies.len() {
                    [0; 32]
                } else {
                    proved[i].s_out
                },
                proof: proved[i].proof,
            })
            .collect();
        let last = chain.last.first;
        Note {
            vk_sha256: match which {
                Key2::Current => *vk::VK.sha256,
                Key2::Previous => *vk::PREVIOUS.unwrap().sha256,
            },
            payee,
            payee_ata,
            issuer_key: chain.issue.issuer,
            lock_seq: chain.issue.lock_seq,
            lock: lock.lock,
            mint: self.w.env.mint,
            amount: chain.issue.amount,
            cum_end: chain.issue.cum_end,
            pay_amount: last.amount,
            expiry: last.caveats.expiry,
            lock_until: lock.lock_until,
            wire,
            chain,
        }
    }

    /// The chain of an issue of `issuer`'s lock for `amount` from `start`, passed on by `spends`
    /// devices and paid to `payee`; `tag` makes another chain of the same shape.
    #[allow(clippy::too_many_arguments)]
    pub fn chain(
        &self,
        issuer: &Issuer,
        spends: usize,
        start: u64,
        amount: u64,
        payee: &Pubkey,
        tag: u8,
        expiry: u32,
    ) -> Chain {
        assert!((1..=16).contains(&spends));
        let holders: Vec<Key> = (0..spends)
            .map(|j| Key::from_index(100 + j as u32))
            .collect();
        let mut chain = Chain::issue(
            &issuer.key,
            &self.w.env.mint,
            0,
            start,
            amount,
            holders[0].owner(),
            caveats(expiry, spends as u8),
        );
        for (i, holder) in holders.iter().enumerate() {
            let salt = tag.wrapping_add(i as u8 + 1);
            chain = match holders.get(i + 1) {
                None => chain.spend1_to_account(holder, 0, payee, NO_LOCK, salt),
                Some(next) => chain.spend(holder, 0, |c| Spend {
                    input: c.id,
                    lock_seq: 0,
                    salt: [salt; 16],
                    outputs: Outputs::One {
                        owner: next.owner(),
                        caveats: Caveats {
                            hops_left: c.caveats.hops_left - 1,
                            ..c.caveats
                        },
                    },
                }),
            };
        }
        chain
    }

    pub fn note_of(&self, which: Key2, chain: Chain) -> Note {
        self.note_of_to(which, chain, self.w.winner, self.w.winner_token)
    }

    pub fn note_of_to(&self, which: Key2, chain: Chain, payee: Pubkey, ata: Pubkey) -> Note {
        self.proved(which, chain, payee, ata, &self.w.issuer)
    }

    /// A note of `spends` spends paying `AMOUNT` from the issuer's lock; `tag` makes another one.
    pub fn private_note_tagged(&self, spends: usize, tag: u8) -> Note {
        self.private_note_paying_from(&self.w.issuer, Key2::Current, spends, tag, AMOUNT)
    }

    pub fn private_note(&self, spends: usize) -> Note {
        self.private_note_tagged(spends, 0)
    }

    pub fn private_note_under_previous_vk(&self, spends: usize, tag: u8) -> Note {
        self.private_note_paying_from(&self.w.issuer, Key2::Previous, spends, tag, AMOUNT)
    }

    pub fn private_note_paying_from(
        &self,
        issuer: &Issuer,
        which: Key2,
        spends: usize,
        tag: u8,
        amount: u64,
    ) -> Note {
        let start = u64::from(tag) * 1_000_000;
        let chain = self.chain(
            issuer,
            spends,
            start,
            amount,
            &self.w.winner,
            tag,
            self.w.expiry,
        );
        self.proved(which, chain, self.w.winner, self.w.winner_token, issuer)
    }

    /// A note paying `amount` from `issuer`'s lock; `tag` is derived from the amount.
    pub fn private_note_paying(&self, issuer: &Issuer, spends: usize, amount: u64) -> Note {
        let tag = (amount % 200) as u8 + 1;
        self.private_note_paying_from(issuer, Key2::Current, spends, tag, amount)
    }

    /// The payment branch and the change branch of a split note: they share their first two
    /// messages' bodies and consume the same first output.
    pub fn branch_notes(&self) -> (Note, Note) {
        let issuer = &self.w.issuer;
        let (k1, k2) = (Key::from_index(100), Key::from_index(101));
        let base = Chain::issue(
            &issuer.key,
            &self.w.env.mint,
            0,
            90_000_000,
            AMOUNT,
            k1.owner(),
            caveats(self.w.expiry, 2),
        );
        let split = base.spend2(&k1, 0, k2.owner(), AMOUNT / 2, 0, 1);
        let payment = split
            .clone()
            .spend1_to_account(&k2, 0, &self.w.winner, NO_LOCK, 2);
        let change = split.spend1_to_account(&k1, 1, &self.payee_b, NO_LOCK, 3);
        (
            self.proved(
                Key2::Current,
                payment,
                self.w.winner,
                self.w.winner_token,
                issuer,
            ),
            self.proved(
                Key2::Current,
                change,
                self.payee_b,
                self.payee_b_ata,
                issuer,
            ),
        )
    }

    /// A private note and a clear one that consume the first output of the same issue with
    /// different content; the private one pays the winner.
    pub fn winning_note(&self) -> Note {
        self.note_of(Key2::Current, self.w.winning(0))
    }

    /// A note whose issue is above the lock's backing, with valid proofs.
    pub fn note_beyond_backing(&self, spends: usize) -> Note {
        let issuer = &self.w.issuer;
        let amount = issuer.backing + 1;
        self.private_note_paying_from(issuer, Key2::Current, spends, 9, amount)
    }

    pub fn lock_ending_before_expiry(&mut self) -> (Issuer, Note) {
        let issuer = self.w.env.issuer(5, BOND, 100_000_000, 20);
        let chain = self.chain(
            &issuer,
            2,
            0,
            AMOUNT,
            &self.w.winner,
            0,
            self.w.expiry + 30 * DAY,
        );
        let note = self.proved(
            Key2::Current,
            chain,
            self.w.winner,
            self.w.winner_token,
            &issuer,
        );
        (issuer, note)
    }

    pub fn funded_lock(&mut self, seed: u8) -> Issuer {
        self.w.env.issuer(seed, BOND, 1_000_000_000, 60)
    }

    pub fn note_with_unrecordable_output(&self) -> Note {
        let issuer = &self.w.issuer;
        let holder = Key::from_index(100);
        let (issue, envelope, _) = (0u16..)
            .map(|n| {
                let issue = buckspay_protocol::Issue {
                    issuer: issuer.key.sec1(),
                    mint: self.w.env.mint.to_bytes(),
                    lock_seq: 0,
                    cum_end: AMOUNT,
                    salt: salted([0x5b; 16], n),
                    owner: holder.owner(),
                    amount: AMOUNT,
                    caveats: caveats(self.w.expiry, 1),
                };
                let (envelope, output) =
                    chain::issue_signing(&buckspay::note_domain(), &issue).unwrap();
                (issue, envelope, output)
            })
            .find(|(_, _, output)| !recordable(&output.id))
            .unwrap();
        let (holding, _) = (
            chain::issue_signing(&buckspay::note_domain(), &issue)
                .unwrap()
                .1,
            (),
        );
        let base = Chain {
            issue_body: issue.body(),
            links: vec![],
            signed: vec![Signed {
                key: issuer.key.sec1(),
                envelope,
                signature: issuer.key.sign(&envelope),
            }],
            last: buckspay_protocol::chain::Holding {
                first: holding,
                second: None,
            },
            issue,
        };
        let chain = base.spend1_to_account(&holder, 0, &self.w.winner, NO_LOCK, 1);
        self.proved(
            Key2::Current,
            chain,
            self.w.winner,
            self.w.winner_token,
            issuer,
        )
    }

    // Proof buffer.

    pub fn open_ix(&self, payer: &Pubkey, nonce: u64, len: u32) -> Instruction {
        Instruction {
            program_id: buckspay::ID,
            accounts: buckspay::accounts::OpenProofBuffer {
                payer: *payer,
                buffer: buffer_address(payer, nonce),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: buckspay::instruction::OpenProofBuffer { nonce, len }.data(),
        }
    }

    pub fn write_ix(&self, payer: &Pubkey, nonce: u64, offset: u32, data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: buckspay::ID,
            accounts: buckspay::accounts::WriteProofBuffer {
                payer: *payer,
                buffer: buffer_address(payer, nonce),
            }
            .to_account_metas(None),
            data: buckspay::instruction::WriteProofBuffer { offset, data }.data(),
        }
    }

    pub fn close_ix(&self, payer: &Pubkey, nonce: u64) -> Instruction {
        Instruction {
            program_id: buckspay::ID,
            accounts: buckspay::accounts::CloseProofBuffer {
                payer: *payer,
                buffer: buffer_address(payer, nonce),
            }
            .to_account_metas(None),
            data: buckspay::instruction::CloseProofBuffer {}.data(),
        }
    }

    /// The messages of a note as the buffer holds them.
    pub fn wire_bytes(note: &Note) -> Vec<u8> {
        let mut out = vec![];
        for m in &note.wire {
            out.extend_from_slice(&m.content);
            out.push(m.next_bit);
            out.extend_from_slice(&m.s_out);
            out.extend_from_slice(&m.proof);
        }
        out
    }

    /// Opens a buffer and writes the first `parts` of `chunks` equal pieces of the note's messages.
    pub fn buffer_with(
        &mut self,
        note: &Note,
        nonce: u64,
        written: usize,
    ) -> Result<Pubkey, Failed> {
        let payer = self.gateway();
        let bytes = Self::wire_bytes(note);
        self.send_ix(self.open_ix(&payer, nonce, bytes.len() as u32))?;
        let half = bytes.len() / 2 / buckspay::zk::WIRE_LEN * buckspay::zk::WIRE_LEN;
        let pieces = [&bytes[..half], &bytes[half..]];
        let mut offset = 0u32;
        for piece in pieces.iter().take(written) {
            self.send_ix(self.write_ix(&payer, nonce, offset, piece.to_vec()))?;
            offset += piece.len() as u32;
        }
        Ok(buffer_address(&payer, nonce))
    }

    // Reads.

    pub fn balance(&self, token: &Pubkey) -> u64 {
        self.w.env.balance(token)
    }

    pub fn no_records_written(&self, note: &Note) -> bool {
        note.consumed()
            .iter()
            .all(|(output, _)| self.w.env.spent(output).is_none())
    }

    pub fn warp_seconds(&mut self, seconds: i64) {
        let now = i64::from(self.w.env.now());
        self.w.env.warp(now + seconds);
    }
}
