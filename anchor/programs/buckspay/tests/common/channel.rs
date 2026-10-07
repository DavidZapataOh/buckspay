//! Delivery-word channels in the harness: the reward pool, payers with a funded lock and a signed
//! commitment, and the builder of `settle_channel` with every field a test may alter.
use super::{
    claims,
    notes::Chain,
    poseidon::{hash, poseidon2},
    zk::Cluster,
    *,
};
use anchor_lang::{solana_program::instruction::AccountMeta, InstructionData, ToAccountMetas};
use buckspay::{rewards::RewardTree, ChannelWords, RewardPolicy, SettleChannelArgs, WireWord};

#[path = "rewards.rs"]
pub mod rewards;
use buckspay_protocol::{
    hash::{content, domain, purpose},
    payword::{self, Commitment},
    secp256r1, NO_LOCK,
};

pub const R: [u8; 32] = buckspay_zk_verify::fr::MODULUS;
pub const R_MINUS_1: [u8; 32] = {
    let mut x = R;
    x[31] -= 1;
    x
};

const WORD_VALUE: u64 = 500_000;
const WORD_FEE: u64 = 10_000;
const BACKING: u64 = 160_000_000;
const POOL_LIVE_DAYS: u32 = 60;
const NOTE_AMOUNT: u64 = 8_000_000;

/// Runs `f` once on the feature set of each live cluster.
pub fn each_cluster(f: impl Fn(&mut ChannelEnv)) {
    for cluster in [Cluster::Devnet, Cluster::Mainnet] {
        f(&mut ChannelEnv::new(cluster));
    }
}

pub fn program_data_address() -> Pubkey {
    Pubkey::find_program_address(
        &[buckspay::ID.as_ref()],
        &anchor_lang::solana_program::bpf_loader_upgradeable::id(),
    )
    .0
}

pub fn reward_config_address() -> Pubkey {
    Pubkey::find_program_address(&[b"reward-config"], &buckspay::ID).0
}

pub fn reward_mint_address(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"reward-mint", mint.as_ref()], &buckspay::ID).0
}

pub fn reward_tree_address(mint: &Pubkey, epoch: u32) -> Pubkey {
    Pubkey::find_program_address(
        &[b"reward-tree", mint.as_ref(), &epoch.to_le_bytes()],
        &buckspay::ID,
    )
    .0
}

pub fn channel_address(lock: &Pubkey, hash: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"channel", lock.as_ref(), hash], &buckspay::ID)
}

pub fn read_tree(env: &Env, address: &Pubkey) -> RewardTree {
    let data = env.svm.get_account(address).unwrap().data;
    *anchor_lang::__private::bytemuck::from_bytes::<RewardTree>(
        &data[8..8 + std::mem::size_of::<RewardTree>()],
    )
}

/// The refusal of a transaction, with the program error code if it is one.
#[derive(Debug)]
pub struct Refused(pub TransactionError);

impl Refused {
    pub fn code(&self) -> u32 {
        match &self.0 {
            TransactionError::InstructionError(_, InstructionError::Custom(code)) => *code,
            other => panic!("not a program error: {other:?}"),
        }
    }
}

pub struct PayerChannel {
    pub issuer: Issuer,
    pub lock_seq: u32,
    pub backing: u64,
    pub bond: u64,
    pub words: Vec<[u8; 32]>,
    pub commitment: Commitment,
    pub root: [u8; 32],
    pub expiry: u32,
    pub address: Pubkey,
    pub bump: u8,
}

impl PayerChannel {
    pub fn proof(&self, index: u16) -> WireWord {
        let mut level: Vec<[u8; 32]> = self
            .words
            .iter()
            .enumerate()
            .map(|(i, w)| payword::leaf(i as u16, w))
            .collect();
        let (mut at, mut path) = (usize::from(index), vec![]);
        while level.len() > 1 {
            path.push(level[at ^ 1]);
            level = level
                .chunks(2)
                .map(|p| payword::node(&p[0], &p[1]))
                .collect();
            at /= 2;
        }
        WireWord {
            index,
            word: self.words[usize::from(index)],
            path,
        }
    }

    fn envelope(&self) -> [u8; 96] {
        payword::payword_signing(&payword_domain(), &self.commitment).unwrap()
    }
}

fn payword_domain() -> [u8; 32] {
    domain(
        purpose::PAYWORD,
        &buckspay::GENESIS_HASH,
        &buckspay::ID.to_bytes(),
    )
}

pub struct ChannelSpec {
    pub lock: Pubkey,
    pub channel: Pubkey,
    pub args: ChannelWords,
    pub signer: Key,
    pub envelope: [u8; 96],
}

/// One `settle_channel` transaction.
pub struct Settle {
    pub channels: Vec<ChannelSpec>,
    pub inners: Vec<[u8; 32]>,
}

impl Settle {
    pub fn new() -> Self {
        Settle {
            channels: vec![],
            inners: vec![],
        }
    }

    fn add(mut self, c: &PayerChannel, indexes: &[u16], first: bool) -> Self {
        self.channels.push(ChannelSpec {
            lock: c.issuer.lock,
            channel: c.address,
            args: ChannelWords {
                issuer_key: c.issuer.key.sec1(),
                lock_seq: c.lock_seq,
                commitment: first.then(|| c.commitment.encode()),
                words: indexes.iter().map(|&i| c.proof(i)).collect(),
            },
            signer: c.issuer.key.clone(),
            envelope: c.envelope(),
        });
        self
    }

    pub fn first(self, c: &PayerChannel, indexes: &[u16]) -> Self {
        self.add(c, indexes, true)
    }

    pub fn again(self, c: &PayerChannel, indexes: &[u16]) -> Self {
        self.add(c, indexes, false)
    }

    pub fn with_word_of(mut self, other: &PayerChannel, index: u16) -> Self {
        self.channels
            .last_mut()
            .unwrap()
            .args
            .words
            .push(other.proof(index));
        self
    }

    pub fn signed_by(mut self, key: Key) -> Self {
        self.channels.last_mut().unwrap().signer = key;
        self
    }

    pub fn lock_seq(mut self, seq: u32) -> Self {
        self.channels.last_mut().unwrap().args.lock_seq = seq;
        self
    }

    pub fn with_noncanonical_channel_bump(mut self) -> Self {
        let c = self.channels.last_mut().unwrap();
        let hash = content(&c.args.commitment.unwrap());
        let (_, canonical) = channel_address(&c.lock, &hash);
        c.channel = (0..canonical)
            .rev()
            .find_map(|bump| {
                Pubkey::create_program_address(
                    &[b"channel", c.lock.as_ref(), &hash, &[bump]],
                    &buckspay::ID,
                )
                .ok()
            })
            .expect("a second valid bump");
        self
    }

    /// `canonical_exps(m)` random-looking inners below r; none if `m` has no decomposition.
    pub fn inners_for(self, m: u32) -> Self {
        let count = payword::canonical_exps(m).map_or(0, |e| e.len());
        self.inners(count)
    }

    pub fn inners(mut self, count: usize) -> Self {
        self.inners = (0..count)
            .map(|k| {
                let mut inner = content(&[0xaa, k as u8, self.channels.len() as u8]);
                inner[0] = 0;
                inner
            })
            .collect();
        self
    }

    pub fn inners_with(mut self, inners: &[[u8; 32]]) -> Self {
        self.inners = inners.to_vec();
        self
    }
}

pub struct ChannelEnv {
    pub env: Env,
    pub cluster: Cluster,
    pub authority: Keypair,
    pub admin: Keypair,
    pub pauser: Keypair,
    pub stranger: Keypair,
    pub fee_account: Pubkey,
    pub reward_mint: Pubkey,
    pub pool_ledger: Pubkey,
    pub pool_escrow: Pubkey,
    pub tree: Pubkey,
    next_key: u32,
    tracked: Vec<Pubkey>,
    baseline: Vec<Option<Vec<u8>>>,
    fee_before: u64,
    pub leaves: Vec<[u8; 32]>,
    pub last_logs: Vec<String>,
    pub claims: rewards::State,
}

fn dup(issuer: &Issuer) -> Issuer {
    Issuer {
        key: issuer.key.clone(),
        wallet: issuer.wallet.insecure_clone(),
        lock: issuer.lock,
        lock_until: issuer.lock_until,
        wallet_token: issuer.wallet_token,
        backing: issuer.backing,
    }
}

impl ChannelEnv {
    /// The program with its reward configuration and no mint configured.
    pub fn bare(cluster: Cluster) -> Self {
        let mut env = Env::new_on(cluster.svm(), MintSetup::classic());
        let fee_account = env.token_account_of(&Pubkey::new_from_array([0x66; 32]), 0);
        let reward_mint = reward_mint_address(&env.mint);
        let mut e = Self {
            cluster,
            authority: Keypair::new(),
            admin: Keypair::new(),
            pauser: Keypair::new(),
            stranger: Keypair::new(),
            fee_account,
            reward_mint,
            pool_ledger: ledger_address(&reward_mint),
            pool_escrow: escrow_address(&reward_mint),
            tree: reward_tree_address(&env.mint, 0),
            env,
            next_key: 1,
            tracked: vec![],
            baseline: vec![],
            fee_before: 0,
            leaves: vec![],
            last_logs: vec![],
            claims: rewards::State::default(),
        };
        for k in [&e.authority, &e.admin, &e.pauser, &e.stranger] {
            e.env.svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        }
        let mut data = e.env.svm.get_account(&program_data_address()).unwrap();
        data.data[12] = 1;
        data.data[13..45].copy_from_slice(e.authority.pubkey().as_ref());
        e.env.set_account(program_data_address(), data);

        let authority = e.authority.insecure_clone();
        let ix = e.init_config_ix(&authority.pubkey());
        e.env.send(&authority, &[ix]).unwrap();
        e.tracked = vec![
            e.pool_ledger,
            e.pool_escrow,
            e.tree,
            e.fee_account,
            e.reward_mint,
        ];
        e
    }

    pub fn new(cluster: Cluster) -> Self {
        let mut e = Self::bare(cluster);
        let admin = e.admin.insecure_clone();
        let ix = e.init_mint_ix(&admin.pubkey(), e.policy());
        e.env.send(&admin, &[ix]).unwrap();
        e.refresh();
        e
    }

    pub fn admin_ix(&self, signer: &Pubkey, paused: bool) -> Instruction {
        Instruction {
            program_id: buckspay::ID,
            accounts: buckspay::accounts::RewardAdmin {
                signer: *signer,
                reward_config: reward_config_address(),
            }
            .to_account_metas(None),
            data: buckspay::instruction::SetRewardsPaused { paused }.data(),
        }
    }

    pub fn set_policy_ix(
        &self,
        signer: &Pubkey,
        claim_fee: u64,
        fee_account: Pubkey,
        claim_cap: u64,
    ) -> Instruction {
        Instruction {
            program_id: buckspay::ID,
            accounts: buckspay::accounts::SetRewardPolicy {
                admin: *signer,
                reward_config: reward_config_address(),
                reward_mint: self.reward_mint,
            }
            .to_account_metas(None),
            data: buckspay::instruction::SetRewardPolicy {
                claim_fee,
                fee_account,
                claim_cap,
            }
            .data(),
        }
    }

    pub fn rotate_ix(&self, payer: &Pubkey) -> Instruction {
        let epoch = self.reward_mint_account().epoch;
        Instruction {
            program_id: buckspay::ID,
            accounts: buckspay::accounts::RotateRewardTree {
                payer: *payer,
                reward_mint: self.reward_mint,
                current: reward_tree_address(&self.env.mint, epoch),
                next: reward_tree_address(&self.env.mint, epoch + 1),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: buckspay::instruction::RotateRewardTree {}.data(),
        }
    }

    pub fn reward_mint_account(&self) -> buckspay::RewardMint {
        self.env.account(&self.reward_mint)
    }

    /// Rotates to the next epoch's tree and follows it.
    pub fn rotate(&mut self) -> Result<Landed, Refused> {
        let payer = self.env.payer.insecure_clone();
        let ix = self.rotate_ix(&payer.pubkey());
        let landed = self.env.send(&payer, &[ix]).map_err(Refused)?;
        let epoch = self.reward_mint_account().epoch;
        self.tree = reward_tree_address(&self.env.mint, epoch);
        self.tracked.push(self.tree);
        self.refresh();
        Ok(landed)
    }

    /// Makes the current tree look as full as after `next_index` appends.
    pub fn set_tree_next_index(&mut self, next_index: u32) {
        let mut account = self.env.svm.get_account(&self.tree).unwrap();
        let offset = 8 + 32 + 4;
        account.data[offset..offset + 4].copy_from_slice(&next_index.to_le_bytes());
        self.env.set_account(self.tree, account);
        self.refresh();
    }

    pub fn policy(&self) -> RewardPolicy {
        RewardPolicy {
            word_value: WORD_VALUE,
            word_fee: WORD_FEE,
            max_fee: 900_000,
            claim_fee: 450_000,
            fee_account: self.fee_account,
            claim_cap: 500_000_000,
        }
    }

    pub fn init_config_ix(&self, signer: &Pubkey) -> Instruction {
        Instruction {
            program_id: buckspay::ID,
            accounts: buckspay::accounts::InitRewardConfig {
                authority: *signer,
                reward_config: reward_config_address(),
                program: buckspay::ID,
                program_data: program_data_address(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: buckspay::instruction::InitRewardConfig {
                admin: self.admin.pubkey(),
                pauser: self.pauser.pubkey(),
                claim_key: super::zk::key_hashes(buckspay_zk_verify::vk::CLAIM.sha256),
            }
            .data(),
        }
    }

    pub fn init_mint_ix(&self, signer: &Pubkey, policy: RewardPolicy) -> Instruction {
        Instruction {
            program_id: buckspay::ID,
            accounts: buckspay::accounts::InitRewardMint {
                admin: *signer,
                reward_config: reward_config_address(),
                mint: self.env.mint,
                reward_mint: self.reward_mint,
                pool_ledger: self.pool_ledger,
                pool_escrow: self.pool_escrow,
                tree: self.tree,
                token_program: self.env.token_program,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: buckspay::instruction::InitRewardMint { policy }.data(),
        }
    }

    pub fn unit(&self) -> u64 {
        WORD_VALUE - WORD_FEE
    }
    pub fn word_fee(&self) -> u64 {
        WORD_FEE
    }
    pub fn word_value(&self) -> u64 {
        WORD_VALUE
    }
    pub fn grace(&self) -> u32 {
        buckspay_protocol::GRACE
    }
    pub fn gateway(&self) -> Pubkey {
        self.env.payer.pubkey()
    }
    pub fn stranger_key(&self) -> Key {
        Key::from_index(9_999)
    }

    fn snapshot(&self) -> Vec<Option<Vec<u8>>> {
        self.env.digest(&self.tracked)
    }

    fn refresh(&mut self) {
        self.baseline = self.snapshot();
    }

    pub fn assert_no_writes(&self) {
        assert_eq!(
            self.snapshot(),
            self.baseline,
            "a refused transaction wrote"
        );
    }

    pub fn assert_unchanged_since_last_success(&self) {
        self.assert_no_writes();
    }

    pub fn warp_to(&mut self, unix: u32) {
        self.env.warp(i64::from(unix));
    }

    fn new_issuer(&mut self, bond: u64, days: u32) -> Issuer {
        let key = Key::from_index(self.next_key);
        self.next_key += 1;
        let issuer = self.env.issuer_with_key(key, bond, BACKING, days);
        for a in [
            issuer.lock,
            ledger_address(&issuer.lock),
            escrow_address(&issuer.lock),
        ] {
            self.tracked.push(a);
        }
        issuer
    }

    pub fn lock_with_bond(&mut self, bond: u64) -> Issuer {
        self.new_issuer(bond, POOL_LIVE_DAYS)
    }

    fn build(
        &mut self,
        issuer: Issuer,
        depth: u8,
        word_value: u64,
        expiry: u32,
        bond: u64,
    ) -> PayerChannel {
        let seed = content(&[0x5e, self.next_key as u8, (self.next_key >> 8) as u8, depth]);
        self.next_key += 1;
        let words: Vec<[u8; 32]> = (0..1u16 << depth)
            .map(|i| content(&[&seed[..], &i.to_be_bytes()].concat()))
            .collect();
        let commitment = Commitment {
            mint: self.env.mint.to_bytes(),
            lock_seq: 0,
            cum_end: BACKING,
            depth,
            word_value,
            root: payword::root(&words),
            expiry,
        };
        let (address, bump) = channel_address(&issuer.lock, &commitment.hash());
        self.tracked.push(address);
        self.refresh();
        PayerChannel {
            root: commitment.root,
            issuer,
            lock_seq: 0,
            backing: BACKING,
            bond,
            words,
            commitment,
            expiry,
            address,
            bump,
        }
    }

    fn bond_for(depth: u8, word_value: u64) -> u64 {
        4 * (word_value << depth)
    }

    pub fn payer_channel(&mut self, depth: u8) -> PayerChannel {
        self.payer_channel_with_value(depth, WORD_VALUE)
    }

    pub fn payer_channel_with_value(&mut self, depth: u8, word_value: u64) -> PayerChannel {
        let bond = Self::bond_for(depth, word_value);
        let issuer = self.new_issuer(bond, POOL_LIVE_DAYS);
        let expiry = self.env.now() + 10 * DAY;
        self.build(issuer, depth, word_value, expiry, bond)
    }

    pub fn channel_on(&mut self, issuer: &Issuer, depth: u8) -> PayerChannel {
        let bond = self.env.ledger(&issuer.lock).bond_free;
        let expiry = self.env.now() + 10 * DAY;
        self.build(dup(issuer), depth, WORD_VALUE, expiry, bond)
    }

    pub fn channel_same_lock_other_seed(&mut self, c: &PayerChannel) -> PayerChannel {
        let expiry = c.expiry;
        self.build(
            dup(&c.issuer),
            c.commitment.depth,
            WORD_VALUE,
            expiry,
            c.bond,
        )
    }

    pub fn payer_channel_expiring_after_the_lock(&mut self) -> PayerChannel {
        let bond = Self::bond_for(4, WORD_VALUE);
        let issuer = self.new_issuer(bond, 20);
        let expiry = issuer.lock_until + 30 * DAY;
        self.build(issuer, 4, WORD_VALUE, expiry, bond)
    }

    pub fn channel_past_lock_end(&mut self) -> PayerChannel {
        let bond = Self::bond_for(4, WORD_VALUE);
        let issuer = self.new_issuer(bond, 20);
        let expiry = issuer.lock_until + 5 * DAY;
        let c = self.build(issuer, 4, WORD_VALUE, expiry, bond);
        let until = c.issuer.lock_until;
        self.warp_to(until + 1);
        c
    }

    pub fn send(&mut self, s: Settle) -> Result<Landed, Refused> {
        let payer = self.gateway();
        let mut ixs = vec![];
        let first: Vec<&ChannelSpec> = s
            .channels
            .iter()
            .filter(|c| c.args.commitment.is_some())
            .collect();
        if !first.is_empty() {
            let entries: Vec<secp256r1::Expected> = first
                .iter()
                .map(|c| (c.signer.sec1(), c.envelope))
                .collect();
            let signatures: Vec<[u8; 64]> =
                first.iter().map(|c| c.signer.sign(&c.envelope)).collect();
            ixs.push(precompile_ix(&entries, &signatures));
        }
        let mut accounts = buckspay::accounts::SettleChannel {
            payer,
            reward_mint: self.reward_mint,
            pool_ledger: self.pool_ledger,
            pool_escrow: self.pool_escrow,
            fee_account: self.fee_account,
            tree: self.tree,
            mint: self.env.mint,
            instructions: solana_instructions_sysvar::ID,
            token_program: self.env.token_program,
            system_program: system_program::ID,
        }
        .to_account_metas(None);
        for c in &s.channels {
            accounts.push(AccountMeta::new_readonly(c.lock, false));
            accounts.push(AccountMeta::new(ledger_address(&c.lock), false));
            accounts.push(AccountMeta::new(escrow_address(&c.lock), false));
            accounts.push(AccountMeta::new(c.channel, false));
        }
        ixs.push(Instruction {
            program_id: buckspay::ID,
            accounts,
            data: buckspay::instruction::SettleChannel {
                args: SettleChannelArgs {
                    channels: s.channels.iter().map(|c| clone_words(&c.args)).collect(),
                    inners: s.inners.clone(),
                },
            }
            .data(),
        });
        self.fee_before = self.env.balance(&self.fee_account);
        let landed = self.env.send_v1(&ixs).map_err(Refused)?;
        self.last_logs = self.env.logs().lines().map(str::to_owned).collect();
        for event in self.events() {
            self.leaves.push(event.leaf);
            self.claims.tree_leaves.push((event.epoch, event.leaf));
        }
        self.refresh();
        Ok(landed)
    }

    pub fn error(&self, name: &str) -> u32 {
        use buckspay::BuckspayError as E;
        6000 + match name {
            "WordRejected" => E::WordRejected,
            "ChannelAboveBondQuarter" => E::ChannelAboveBondQuarter,
            "WordAlreadySettled" => E::WordAlreadySettled,
            "InnersDoNotMatchWords" => E::InnersDoNotMatchWords,
            "NonCanonicalInner" => E::NonCanonicalInner,
            "ChainVerification" => E::ChainVerification,
            "WrongLock" => E::WrongLock,
            "CommitmentInvalid" => E::CommitmentInvalid,
            "WordValueMismatch" => E::WordValueMismatch,
            "ChannelWindowClosed" => E::ChannelWindowClosed,
            "InsufficientEscrow" => E::InsufficientEscrow,
            "ChannelStillOpen" => E::ChannelStillOpen,
            "RecordAccounts" => E::RecordAccounts,
            "TreeFull" => E::TreeFull,
            "NotRewardAdmin" => E::NotRewardAdmin,
            "FeeAboveValue" => E::FeeAboveValue,
            "TreeNotFull" => E::TreeNotFull,
            "RewardsPaused" => E::RewardsPaused,
            "UnknownRoot" => E::UnknownRoot,
            "NullifierReused" => E::NullifierReused,
            "NonCanonicalNullifier" => E::NonCanonicalNullifier,
            "ClaimRejected" => E::ClaimRejected,
            "FeeAboveMax" => E::FeeAboveMax,
            "ClaimCapExceeded" => E::ClaimCapExceeded,
            "StaleClaimKey" => E::StaleClaimKey,
            "ClaimCount" => E::ClaimCount,
            "BadDenomination" => E::BadDenomination,
            "WrongRewardTree" => E::WrongRewardTree,
            "WrongNullifierAccount" => E::WrongNullifierAccount,
            other => panic!("unknown error {other}"),
        } as u32
    }

    /// Sends `s` and requires the program to refuse it with the error `name`.
    pub fn refuses(&mut self, s: Settle, name: &str) {
        self.refuses_as(s, name, name);
    }

    pub fn refuses_as(&mut self, s: Settle, name: &str, case: &str) {
        match self.send(s) {
            Ok(_) => panic!("{case} accepted"),
            Err(refused) => assert_eq!(refused.code(), self.error(name), "{case}: {refused:?}"),
        }
    }

    pub fn pool_balance(&self) -> u64 {
        self.env.balance(&self.pool_escrow)
    }

    pub fn fee_account_delta(&self) -> u64 {
        self.env.balance(&self.fee_account) - self.fee_before
    }

    pub fn lock_backing_drawn(&self, c: &PayerChannel) -> u64 {
        c.backing - self.env.ledger(&c.issuer.lock).backing_left
    }

    pub fn lock_bond(&self, c: &PayerChannel) -> u64 {
        self.env.ledger(&c.issuer.lock).bond_free
    }

    pub fn tree_next_index(&self) -> u32 {
        read_tree(&self.env, &self.tree).next_index
    }

    pub fn roots_pushed(&self) -> u32 {
        read_tree(&self.env, &self.tree).root_index
    }

    fn events(&self) -> Vec<buckspay::LeafAppended> {
        use anchor_lang::Discriminator;
        use base64::Engine as _;
        self.last_logs
            .iter()
            .filter_map(|l| l.strip_prefix("Program data: "))
            .filter_map(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
            .filter(|d| d.starts_with(buckspay::LeafAppended::DISCRIMINATOR))
            .map(|d| anchor_lang::AnchorDeserialize::deserialize(&mut &d[8..]).unwrap())
            .collect()
    }

    /// `(index, exp)` of every leaf the last transaction appended.
    pub fn leaf_events(&self) -> Vec<(u32, u8)> {
        self.events().iter().map(|e| (e.index, e.exp)).collect()
    }

    /// The `index`-th leaf appended since the start.
    pub fn leaf_at(&self, index: usize) -> [u8; 32] {
        self.leaves[index]
    }

    pub fn latest_root(&self) -> [u8; 32] {
        let tree = read_tree(&self.env, &self.tree);
        tree.roots[(tree.root_index as usize + buckspay::rewards::ROOT_HISTORY - 1)
            % buckspay::rewards::ROOT_HISTORY]
    }

    pub fn channel_root(&self, c: &PayerChannel) -> [u8; 32] {
        self.channel(c).root
    }

    pub fn channel(&self, c: &PayerChannel) -> buckspay::Channel {
        self.env.account(&c.address)
    }

    pub fn bits_set(&self, c: &PayerChannel, indexes: &[u16]) -> bool {
        let channel = self.channel(c);
        indexes
            .iter()
            .all(|&i| channel.settled[usize::from(i) / 8] >> (i % 8) & 1 == 1)
    }

    pub fn pause_rewards(&mut self) {
        let pauser = self.pauser.insecure_clone();
        let ix = self.admin_ix(&pauser.pubkey(), true);
        self.env.send(&pauser, &[ix]).unwrap();
    }

    pub fn close_channel(&mut self, c: &PayerChannel) -> Result<Landed, Refused> {
        let payer = self.env.payer.insecure_clone();
        let ix = Instruction {
            program_id: buckspay::ID,
            accounts: buckspay::accounts::CloseChannel {
                channel: c.address,
                payer: self.gateway(),
            }
            .to_account_metas(None),
            data: buckspay::instruction::CloseChannel {}.data(),
        };
        let landed = self.env.send(&payer, &[ix]).map_err(Refused)?;
        self.refresh();
        Ok(landed)
    }

    pub fn lamports(&self, address: &Pubkey) -> u64 {
        self.env.lamports(address)
    }

    pub fn token_balance(&self, token: Pubkey) -> u64 {
        self.env.balance(&token)
    }

    /// A lock whose backing is spoken for three times: `rest` takes everything but the channel's
    /// interval, `note` takes the channel's interval, and the channel's words draw from it too.
    pub fn note_and_channel_sharing_backing(&mut self) -> (Note, PayerChannel) {
        let depth = 4;
        let bond = Self::bond_for(depth, WORD_VALUE);
        let issuer = self.new_issuer(bond, POOL_LIVE_DAYS);
        let start = BACKING - (WORD_VALUE << depth);
        let expiry = self.env.now() + 10 * DAY;
        let channel = self.build(dup(&issuer), depth, WORD_VALUE, expiry, bond);
        let payee = Pubkey::new_from_array([0x77; 32]);
        let payee_token = self.env.token_account_of(&payee, 0);
        self.tracked.push(payee_token);
        let holder = Key::new(2);
        let chain = |from: u64, amount: u64, salt: u8| {
            Chain::issue(
                &issuer.key,
                &self.env.mint,
                0,
                from,
                amount,
                holder.owner(),
                caveats(expiry_of(&self.env, 10), 4),
            )
            .spend1_to_account(&holder, 0, &payee, NO_LOCK, salt)
        };
        let (note, rest) = (chain(start, BACKING - start, 1), chain(0, start, 2));
        self.refresh();
        (
            Note {
                issuer,
                chain: note,
                rest,
                payee_token,
                amount: BACKING - start,
            },
            channel,
        )
    }

    pub fn settle_rest(&mut self, note: &Note) -> Result<Landed, TransactionError> {
        let payer = self.gateway();
        let ixs = settle_ixs(
            &self.env,
            &payer,
            &note.issuer,
            &note.rest,
            &note.payee_token,
        );
        let landed = self.env.submit(&ixs)?;
        self.refresh();
        Ok(landed)
    }

    pub fn settle_note(&mut self, note: &Note) -> Result<Landed, TransactionError> {
        let payer = self.gateway();
        let ixs = settle_ixs(
            &self.env,
            &payer,
            &note.issuer,
            &note.chain,
            &note.payee_token,
        );
        let landed = self.env.submit(&ixs)?;
        self.refresh();
        Ok(landed)
    }

    /// Files the note's loss against the lock whose backing the channel's words drew first.
    pub fn claim_unbacked(&mut self, note: &Note) -> Result<Landed, TransactionError> {
        let payer = self.gateway();
        let ixs =
            claims::claim_unbacked_ixs(&payer, &note.issuer.lock, &self.env.mint, &note.chain);
        let landed = self.env.submit(&ixs)?;
        self.refresh();
        Ok(landed)
    }
}

pub struct Note {
    pub issuer: Issuer,
    pub chain: Chain,
    pub rest: Chain,
    pub payee_token: Pubkey,
    pub amount: u64,
}

fn clone_words(c: &ChannelWords) -> ChannelWords {
    ChannelWords {
        issuer_key: c.issuer_key,
        lock_seq: c.lock_seq,
        commitment: c.commitment,
        words: c
            .words
            .iter()
            .map(|w| WireWord {
                index: w.index,
                word: w.word,
                path: w.path.clone(),
            })
            .collect(),
    }
}

/// The root of `leaves` in a Poseidon tree of depth 20 with zero leaves, computed level by level.
pub fn tree_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    let mut zero = [0u8; 32];
    let mut level = leaves.to_vec();
    for _ in 0..20 {
        let mut next = vec![];
        for pair in level.chunks(2) {
            next.push(hash_pair(&pair[0], pair.get(1).unwrap_or(&zero)));
        }
        zero = hash_pair(&zero, &zero);
        level = next;
    }
    level.first().copied().unwrap_or(zero)
}

pub fn hash_pair(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    hash(&[a, b])
}
