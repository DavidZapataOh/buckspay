//! Settlement and reclaim in the harness: issuers with a funded lock, the instructions of every
//! settlement flow, and the sends that report what landed.
use super::*;
use anchor_lang::{solana_program::instruction::AccountMeta, AccountDeserialize};
use buckspay::Spent;
use buckspay_protocol::{
    chain::{self, Holding, Output},
    reclaim::reclaim_envelope,
    secp256r1, Spend,
};
use solana_message::VersionedMessage;

pub const DAY: u32 = 86_400;
pub const T0: i64 = START;

/// A registered device with a lock: the issuer of notes.
pub struct Issuer {
    pub key: Key,
    pub wallet: Keypair,
    pub lock: Pubkey,
    pub lock_until: u32,
    /// An empty token account of the wallet, where a reclaim pays.
    pub wallet_token: Pubkey,
    pub backing: u64,
}

impl Env {
    /// A user with a registered device key, a wallet and a funded lock.
    pub fn issuer(&mut self, seed: u8, bond: u64, backing: u64, days: u32) -> Issuer {
        self.issuer_with_key(Key::new(seed), bond, backing, days)
    }

    pub fn issuer_with_key(&mut self, key: Key, bond: u64, backing: u64, days: u32) -> Issuer {
        let user = self.unregistered_user_with(key, bond + backing);
        let user = self.register(user);
        let lock = lock_for(self, &user, bond, backing, days * DAY);
        let wallet_token = self.token_account_of(&user.wallet.pubkey(), 0);
        Issuer {
            key: user.key,
            wallet: user.wallet,
            lock: lock.address,
            lock_until: lock.until,
            wallet_token,
            backing,
        }
    }

    /// Sends `ixs` as a legacy transaction paid and signed by `payer`.
    pub fn submit(&mut self, ixs: &[Instruction]) -> Result<Landed, TransactionError> {
        let payer = self.payer.insecure_clone();
        self.send_signed(&payer.pubkey(), ixs, &[&payer])
    }

    /// Sends the instructions as a transaction v1 with `payer` as the only signer.
    pub fn send_v1(&mut self, ixs: &[Instruction]) -> Result<Landed, TransactionError> {
        self.send_v1_limited(ixs, 1_024 * 1_024)
    }

    /// The same with an explicit `loaded_accounts_data_size_limit`.
    pub fn send_v1_limited(
        &mut self,
        ixs: &[Instruction],
        loaded_accounts_limit: u32,
    ) -> Result<Landed, TransactionError> {
        self.svm.expire_blockhash();
        let config = solana_message::v1::TransactionConfig {
            compute_unit_limit: Some(1_400_000),
            loaded_accounts_data_size_limit: Some(loaded_accounts_limit),
            ..solana_message::v1::TransactionConfig::empty()
        };
        let message = solana_message::v1::Message::try_compile_with_config(
            &self.payer.pubkey(),
            ixs,
            self.svm.latest_blockhash(),
            config,
        )
        .unwrap();
        let message = VersionedMessage::V1(message);
        let size = message.serialize().len() + 64;
        let tx = VersionedTransaction::try_new(message, &[&self.payer]).unwrap();
        let meta = self.svm.send_transaction(tx).map_err(|failed| {
            self.logs = failed.meta.logs;
            failed.err
        })?;
        self.logs = meta.logs.clone();
        Ok(Landed {
            units: meta.compute_units_consumed,
            size,
        })
    }

    /// Writes a token account of the mint, frozen or not.
    pub fn put_token_account(
        &mut self,
        address: Pubkey,
        owner: &Pubkey,
        amount: u64,
        frozen: bool,
    ) {
        let state = if frozen {
            spl_token::state::AccountState::Frozen
        } else {
            spl_token::state::AccountState::Initialized
        };
        let data = token_account_data(&self.mint, owner, amount, state);
        let lamports = self.rent(data.len());
        self.set_account(
            address,
            Account {
                lamports,
                data,
                owner: self.token_program,
                executable: false,
                rent_epoch: 0,
            },
        );
    }

    /// The record of an output, if it has an address and the account holds one.
    pub fn spent(&self, output: &[u8; 32]) -> Option<Spent> {
        self.svm
            .get_account(&spent_address_of(output)?)
            .filter(|account| !account.data.is_empty())
            .map(|account| Spent::try_deserialize(&mut account.data.as_slice()).unwrap())
    }

    /// The data and lamports of each address: two equal digests mean nothing changed.
    pub fn digest(&self, addresses: &[Pubkey]) -> Vec<Option<Vec<u8>>> {
        addresses
            .iter()
            .map(|address| {
                self.svm.get_account(address).map(|account| {
                    [
                        account.data.clone(),
                        account.lamports.to_le_bytes().to_vec(),
                    ]
                    .concat()
                })
            })
            .collect()
    }
}

pub fn settle_accounts(
    env: &Env,
    payer: &Pubkey,
    issuer: &Issuer,
    destination: &Pubkey,
) -> Vec<AccountMeta> {
    buckspay::accounts::SettleNote {
        payer: *payer,
        lock: issuer.lock,
        ledger: ledger_address(&issuer.lock),
        escrow: escrow_address(&issuer.lock),
        mint: env.mint,
        destination: *destination,
        instructions: solana_instructions_sysvar::ID,
        token_program: env.token_program,
        system_program: system_program::ID,
    }
    .to_account_metas(None)
}

/// The record accounts of a settlement: one per spend (the consumed outputs), or the issue's output.
pub fn record_outputs(chain: &Chain) -> Vec<[u8; 32]> {
    let mut outputs = consumed_outputs(chain);
    if outputs.is_empty() {
        outputs.push(chain_first_output(chain).id);
    }
    outputs
}

pub fn chain_first_output(chain: &Chain) -> Output {
    chain::issue_signing(&buckspay::note_domain(), &chain.issue)
        .unwrap()
        .1
}

/// Output ids consumed by each spend, in order.
pub fn consumed_outputs(chain: &Chain) -> Vec<[u8; 32]> {
    let mut holding = Holding {
        first: chain_first_output(chain),
        second: None,
    };
    let mut out = vec![];
    for link in &chain.links {
        let input = if link.input == 0 {
            holding.first
        } else {
            holding.second.unwrap()
        };
        let spend = Spend::decode(input.id, &link.body).unwrap();
        let (_, env) = chain::spend_signing(&buckspay::note_domain(), &input, &spend).unwrap();
        holding = chain::spend_outputs(&env, &input, &spend).map_or(holding, |(h, _)| h);
        out.push(input.id);
    }
    out
}

pub fn settle_ix(
    env: &Env,
    payer: &Pubkey,
    issuer: &Issuer,
    chain: &Chain,
    destination: &Pubkey,
) -> Instruction {
    let mut accounts = settle_accounts(env, payer, issuer, destination);
    for output in record_outputs(chain) {
        accounts.push(AccountMeta::new(record_account(&output), false));
    }
    Instruction {
        program_id: buckspay::ID,
        accounts,
        data: buckspay::instruction::SettleNote {
            issue: chain.issue_body,
            spends: chain.links.clone(),
        }
        .data(),
    }
}

pub fn settle_ixs(
    env: &Env,
    payer: &Pubkey,
    issuer: &Issuer,
    chain: &Chain,
    destination: &Pubkey,
) -> Vec<Instruction> {
    let signatures: Vec<[u8; 64]> = chain.signed.iter().map(|s| s.signature).collect();
    vec![
        precompile_ix(&chain.entries(), &signatures),
        settle_ix(env, payer, issuer, chain, destination),
    ]
}

/// Reclaim of output `which` of the last message of `chain`, signed by `owner`, with a deadline
/// that never expires in a test.
pub fn reclaim_ixs(
    env: &Env,
    payer: &Pubkey,
    issuer: &Issuer,
    chain: &Chain,
    which: u8,
    owner: &Key,
    destination: &Pubkey,
) -> Vec<Instruction> {
    reclaim_ixs_with(
        env,
        payer,
        issuer,
        chain,
        which,
        owner,
        destination,
        u32::MAX,
    )
}

/// The reclaimed output of the last message of `chain`.
pub fn reclaimed_output(chain: &Chain, which: u8) -> Output {
    if which == 0 {
        chain.last.first
    } else {
        chain.last.second.unwrap()
    }
}

/// What the precompile instruction of a reclaim verifies: the chain, then the owner's reclaim
/// signature with `deadline`.
pub fn reclaim_entries(
    chain: &Chain,
    which: u8,
    owner: &Key,
    deadline: u32,
) -> (Vec<secp256r1::Expected>, Vec<[u8; 64]>) {
    let output = reclaimed_output(chain, which);
    let envelope = reclaim_envelope(&buckspay::reclaim_domain(), &output.id, deadline);
    let mut entries = chain.entries();
    let mut signatures: Vec<[u8; 64]> = chain.signed.iter().map(|s| s.signature).collect();
    entries.push((owner.sec1(), envelope));
    signatures.push(owner.sign(&envelope));
    (entries, signatures)
}

/// The `reclaim_output` instruction alone.
#[allow(clippy::too_many_arguments)]
pub fn reclaim_ix(
    env: &Env,
    payer: &Pubkey,
    issuer: &Issuer,
    chain: &Chain,
    which: u8,
    owner: &Key,
    destination: &Pubkey,
    deadline: u32,
) -> Instruction {
    let output = reclaimed_output(chain, which);
    let mut accounts = buckspay::accounts::ReclaimOutput {
        payer: *payer,
        device: device_address(&owner.sec1()),
        lock: issuer.lock,
        ledger: ledger_address(&issuer.lock),
        escrow: escrow_address(&issuer.lock),
        mint: env.mint,
        destination: *destination,
        instructions: solana_instructions_sysvar::ID,
        token_program: env.token_program,
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    for o in consumed_outputs(chain) {
        accounts.push(AccountMeta::new(record_account(&o), false));
    }
    accounts.push(AccountMeta::new(record_account(&output.id), false));
    Instruction {
        program_id: buckspay::ID,
        accounts,
        data: buckspay::instruction::ReclaimOutput {
            owner: owner.sec1(),
            issue: chain.issue_body,
            spends: chain.links.clone(),
            which,
            deadline,
        }
        .data(),
    }
}

/// Reclaim of output `which` of the last message of `chain`, signed by `owner` with `deadline`.
#[allow(clippy::too_many_arguments)]
pub fn reclaim_ixs_with(
    env: &Env,
    payer: &Pubkey,
    issuer: &Issuer,
    chain: &Chain,
    which: u8,
    owner: &Key,
    destination: &Pubkey,
    deadline: u32,
) -> Vec<Instruction> {
    let (entries, signatures) = reclaim_entries(chain, which, owner, deadline);
    vec![
        precompile_ix(&entries, &signatures),
        reclaim_ix(
            env,
            payer,
            issuer,
            chain,
            which,
            owner,
            destination,
            deadline,
        ),
    ]
}

/// A settlement whose transaction carries the signatures of the messages from `covered` on only:
/// the earlier ones are vouched for by records already on chain.
pub fn settle_ixs_resumed(
    env: &Env,
    payer: &Pubkey,
    issuer: &Issuer,
    chain: &Chain,
    destination: &Pubkey,
    covered: usize,
) -> Vec<Instruction> {
    let signatures: Vec<[u8; 64]> = chain.signed[covered..]
        .iter()
        .map(|s| s.signature)
        .collect();
    let mut ixs = vec![];
    if !signatures.is_empty() {
        ixs.push(precompile_ix(&chain.entries()[covered..], &signatures));
    }
    ixs.push(settle_ix(env, payer, issuer, chain, destination));
    ixs
}

/// The instructions that record the consumed outputs of `chain` without paying anyone; the
/// signatures of the messages before `covered` are left out.
pub fn record_prefix_ixs(
    payer: &Pubkey,
    issuer: &Issuer,
    chain: &Chain,
    covered: usize,
) -> Vec<Instruction> {
    let signatures: Vec<[u8; 64]> = chain.signed[covered..]
        .iter()
        .map(|s| s.signature)
        .collect();
    let mut accounts = buckspay::accounts::RecordPrefix {
        payer: *payer,
        lock: issuer.lock,
        instructions: solana_instructions_sysvar::ID,
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    for o in consumed_outputs(chain) {
        accounts.push(AccountMeta::new(record_account(&o), false));
    }
    let mut ixs = vec![];
    if !signatures.is_empty() {
        ixs.push(precompile_ix(&chain.entries()[covered..], &signatures));
    }
    ixs.push(Instruction {
        program_id: buckspay::ID,
        accounts,
        data: buckspay::instruction::RecordPrefix {
            issue: chain.issue_body,
            spends: chain.links.clone(),
        }
        .data(),
    });
    ixs
}

/// `InstructionError::Custom` of a program error at an instruction index.
pub fn code(index: u8, error: BuckspayError) -> TransactionError {
    TransactionError::InstructionError(index, InstructionError::Custom(6000 + error as u32))
}

pub fn expiry_of(env: &Env, days: u32) -> u32 {
    env.now() + days * DAY
}

/// The forwarding program of `tools/cpi-forwarder`, built for SBF on first use.
pub fn forwarder() -> Vec<u8> {
    static BUILT: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    BUILT
        .get_or_init(|| {
            let manifest =
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tools/cpi-forwarder");
            let out = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("cpi-forwarder");
            let status = std::process::Command::new("cargo")
                .args(["build-sbf", "--manifest-path"])
                .arg(manifest.join("Cargo.toml"))
                .arg("--sbf-out-dir")
                .arg(&out)
                .env("CARGO_TARGET_DIR", out.join("target"))
                .status()
                .expect("cargo build-sbf is on the path");
            assert!(status.success(), "building the forwarding program failed");
            std::fs::read(out.join("cpi_forwarder.so")).unwrap()
        })
        .clone()
}
