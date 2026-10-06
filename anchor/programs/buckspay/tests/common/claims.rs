//! Harness for the claim tests: registered actors, the builders of every instruction of the
//! claim flow and the cast of a double spend.
#![allow(dead_code)]
use anchor_lang::{
    prelude::Pubkey, solana_program::instruction::AccountMeta,
    solana_program::instruction::Instruction, AccountDeserialize, InstructionData, ToAccountMetas,
};
use buckspay::{Claim, Link, LostSpend, CLAIM_SEED};
use buckspay_protocol::record::RECORD_BUMP;
use solana_account::ReadableAccount;
use solana_keypair::Keypair;
use solana_signer::Signer;

use super::*;

/// The error an Anchor account constraint raises.
pub fn constraint(index: u8, code: u32) -> solana_transaction::TransactionError {
    solana_transaction::TransactionError::InstructionError(
        index,
        solana_transaction::InstructionError::Custom(code),
    )
}

pub fn token_id() -> Pubkey {
    anchor_spl::token::ID
}

pub struct Actor {
    pub key: Key,
    pub wallet: Keypair,
    pub wallet_token: Pubkey,
}

/// The claim address of an output, or `None` when the output cannot be claimed.
pub fn claim_address_of(output: &[u8; 32]) -> Option<Pubkey> {
    Pubkey::create_program_address(&[CLAIM_SEED, output, &[RECORD_BUMP]], &buckspay::ID).ok()
}

pub fn claim_address(output: &[u8; 32]) -> Pubkey {
    claim_address_of(output).expect("the output has a claim address")
}

/// The account a transaction names for the claim of `output`: its address, or an arbitrary one for
/// an output that cannot be claimed (the program refuses it before looking at the account).
pub fn claim_account(output: &[u8; 32]) -> Pubkey {
    claim_address_of(output).unwrap_or_else(Pubkey::new_unique)
}

impl Env {
    /// A registered device key with a wallet that has a token account, and no lock.
    pub fn actor(&mut self, seed: u8) -> Actor {
        let user = self.unregistered_user_with(Key::new(seed), 0);
        let user = self.register(user);
        Actor {
            key: user.key,
            wallet: user.wallet,
            wallet_token: user.token,
        }
    }

    pub fn claim(&self, output: &[u8; 32]) -> Option<Claim> {
        claim_address_of(output)
            .and_then(|address| self.svm.get_account(&address))
            .filter(|a| !a.data.is_empty())
            .map(|a| Claim::try_deserialize(&mut a.data()).unwrap())
    }

    pub fn supply(&self) -> u64 {
        let mint = self.svm.get_account(&self.mint).unwrap();
        u64::from_le_bytes(mint.data[36..44].try_into().unwrap())
    }
}

/// Whether the spend `link` carries names no lock: its number sits at bytes 2..6 of the body.
fn names_no_lock(link: &Link) -> bool {
    link.body[2..6] == NO_LOCK.to_le_bytes()
}

/// Builds `claim_lost_spend` for the loser's `chain`, filed by `payer`, against `lock`. The only
/// signature it carries is the culprit's, on the last spend of the chain.
pub fn claim_lost_ixs(
    payer: &Pubkey,
    lock: &Pubkey,
    lock_key: [u8; 33],
    lock_seq: u32,
    mint: &Pubkey,
    chain: &Chain,
) -> Vec<Instruction> {
    let n = chain.links.len();
    let culprit = &chain.signed[n];
    let payment = chain.last.first;
    let contested = consumed_outputs(chain)[n - 1];
    vec![
        precompile_ix(&[(culprit.key, culprit.envelope)], &[culprit.signature]),
        Instruction {
            program_id: buckspay::ID,
            accounts: buckspay::accounts::ClaimLostSpend {
                payer: *payer,
                lock: *lock,
                ledger: ledger_address(lock),
                escrow: escrow_address(lock),
                mint: *mint,
                device: (names_no_lock(&chain.links[n - 1])).then(|| device_address(&lock_key)),
                claim: claim_account(&payment.id),
                record: record_account(&contested),
                instructions: solana_instructions_sysvar::ID,
                token_program: token_id(),
                system_program: solana_sdk_ids::system_program::ID,
            }
            .to_account_metas(None),
            data: buckspay::instruction::ClaimLostSpend {
                lost: LostSpend {
                    issue: chain.issue_body,
                    spends: chain.links.clone(),
                    lock_key,
                    lock_seq,
                },
            }
            .data(),
        },
    ]
}

/// The records `claim_unbacked` reads: what a settlement of the chain would present when an
/// account holds its payment, else the outputs the chain consumed.
pub fn unbacked_records(chain: &Chain) -> Vec<[u8; 32]> {
    match chain.last.first.owner {
        buckspay_protocol::Owner::Account(_) => record_outputs(chain),
        buckspay_protocol::Owner::Device(_) => consumed_outputs(chain),
    }
}

/// Builds `claim_unbacked` for `chain` against the lock of its issuer, filed by `payer`.
pub fn claim_unbacked_ixs(
    payer: &Pubkey,
    lock: &Pubkey,
    mint: &Pubkey,
    chain: &Chain,
) -> Vec<Instruction> {
    claim_unbacked_resumed_ixs(payer, lock, mint, chain, 0)
}

/// The same with the signatures of the messages before `covered` left out: records vouch for them.
pub fn claim_unbacked_resumed_ixs(
    payer: &Pubkey,
    lock: &Pubkey,
    mint: &Pubkey,
    chain: &Chain,
    covered: usize,
) -> Vec<Instruction> {
    let payment = chain.last.first;
    let signatures: Vec<[u8; 64]> = chain.signed[covered..]
        .iter()
        .map(|s| s.signature)
        .collect();
    let mut accounts = buckspay::accounts::ClaimUnbacked {
        payer: *payer,
        lock: *lock,
        ledger: ledger_address(lock),
        escrow: escrow_address(lock),
        mint: *mint,
        claim: claim_account(&payment.id),
        record: record_account(&payment.id),
        instructions: solana_instructions_sysvar::ID,
        token_program: token_id(),
        system_program: solana_sdk_ids::system_program::ID,
    }
    .to_account_metas(None);
    accounts.extend(
        unbacked_records(chain)
            .iter()
            .map(|output| AccountMeta::new_readonly(record_account(output), false)),
    );
    let mut ixs = vec![];
    if !signatures.is_empty() {
        ixs.push(precompile_ix(&chain.entries()[covered..], &signatures));
    }
    ixs.push(Instruction {
        program_id: buckspay::ID,
        accounts,
        data: buckspay::instruction::ClaimUnbacked {
            issue: chain.issue_body,
            spends: chain.links.clone(),
        }
        .data(),
    });
    ixs
}

pub fn close_records_ix(pairs: &[(Pubkey, Pubkey)]) -> Instruction {
    Instruction {
        program_id: buckspay::ID,
        accounts: pairs
            .iter()
            .flat_map(|(record, receiver)| {
                [
                    AccountMeta::new(*record, false),
                    AccountMeta::new(*receiver, false),
                ]
            })
            .collect(),
        data: buckspay::instruction::CloseRecords {}.data(),
    }
}

pub fn withdraw_lock_ix(
    env: &Env,
    wallet: &Pubkey,
    key: &[u8; 33],
    lock: &Pubkey,
    lock_seq: u32,
    destination: &Pubkey,
    rent_receiver: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: buckspay::ID,
        accounts: buckspay::accounts::WithdrawLock {
            wallet: *wallet,
            device: device_address(key),
            lock: *lock,
            ledger: ledger_address(lock),
            escrow: escrow_address(lock),
            mint: env.mint,
            destination: *destination,
            rent_receiver: *rent_receiver,
            token_program: token_id(),
        }
        .to_account_metas(None),
        data: buckspay::instruction::WithdrawLock {
            key: *key,
            lock_seq,
        }
        .data(),
    }
}

pub fn close_lock_ix(
    key: &[u8; 33],
    lock: &Pubkey,
    lock_seq: u32,
    rent_receiver: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: buckspay::ID,
        accounts: buckspay::accounts::CloseLock {
            lock: *lock,
            ledger: ledger_address(lock),
            escrow: escrow_address(lock),
            rent_receiver: *rent_receiver,
            system_program: solana_sdk_ids::system_program::ID,
        }
        .to_account_metas(None),
        data: buckspay::instruction::CloseLock {
            key: *key,
            lock_seq,
        }
        .data(),
    }
}

pub fn links_of(chain: &Chain) -> Vec<Link> {
    chain.links.clone()
}

/// The amount of the note a culprit double spends: within the payment limit of its bond.
pub const AMOUNT: u64 = 20_000_000;
pub const BOND: u64 = 100_000_000;
/// What a lock with `BOND` backs in all and per payment.
pub const EXPOSURE: u64 = 50_000_000;
pub const LIMIT: u64 = 25_000_000;

/// The cast of a double spend: an issuer, a culprit with a bonded lock who holds the issued note, a
/// victim who is paid by the branch that loses, and an account the winning branch pays.
pub struct World {
    pub env: Env,
    pub issuer: Issuer,
    pub culprit: Issuer,
    pub victim: Actor,
    pub winner: Pubkey,
    pub winner_token: Pubkey,
    pub expiry: u32,
}

pub fn world() -> World {
    world_expiring(10)
}

/// A world whose notes expire in `days`: more than 46 days make the end of the lock close the
/// claims of a double spend before its challenge does.
pub fn world_expiring(days: u32) -> World {
    world_in(Env::new(TokenKind::Classic), days)
}

pub fn world_in(mut env: Env, days: u32) -> World {
    let issuer = env.issuer(1, BOND, 1_000_000_000, 60);
    let culprit = env.issuer(2, BOND, 10_000_000, 60);
    let victim = env.actor(3);
    let winner = Pubkey::new_from_array([0x77; 32]);
    let winner_token = env.token_account_of(&winner, 0);
    let expiry = expiry_of(&env, days);
    World {
        env,
        issuer,
        culprit,
        victim,
        winner,
        winner_token,
        expiry,
    }
}

impl World {
    pub fn payer(&self) -> Pubkey {
        self.env.payer.pubkey()
    }

    /// The note the culprit holds: an issue of the issuer's lock for the interval starting at
    /// `start`.
    pub fn base(&self, start: u64) -> Chain {
        self.base_of(start, AMOUNT)
    }

    pub fn base_of(&self, start: u64, amount: u64) -> Chain {
        Chain::issue(
            &self.issuer.key,
            &self.env.mint,
            0,
            start,
            amount,
            self.culprit.key.owner(),
            caveats(self.expiry, 4),
        )
    }

    /// The culprit pays `winner`'s account, naming its lock.
    pub fn winning(&self, start: u64) -> Chain {
        self.winning_of(start, AMOUNT)
    }

    pub fn winning_of(&self, start: u64, amount: u64) -> Chain {
        self.base_of(start, amount)
            .spend1_to_account(&self.culprit.key, 0, &self.winner, 0, 1)
    }

    /// The culprit pays the victim's device key, naming its lock, for the same output.
    pub fn losing(&self, start: u64, salt: u8) -> Chain {
        self.losing_of(start, salt, AMOUNT)
    }

    pub fn losing_of(&self, start: u64, salt: u8, amount: u64) -> Chain {
        self.losing_to_of(start, salt, amount, self.victim.key.owner())
    }

    pub fn losing_to(&self, start: u64, salt: u8, owner: buckspay_protocol::Owner) -> Chain {
        self.losing_to_of(start, salt, AMOUNT, owner)
    }

    pub fn losing_to_of(
        &self,
        start: u64,
        salt: u8,
        amount: u64,
        owner: buckspay_protocol::Owner,
    ) -> Chain {
        self.base_of(start, amount)
            .spend(&self.culprit.key, 0, |c| buckspay_protocol::Spend {
                input: c.id,
                lock_seq: 0,
                salt: [salt; 16],
                outputs: buckspay_protocol::Outputs::One {
                    owner,
                    caveats: buckspay_protocol::Caveats {
                        hops_left: c.caveats.hops_left - 1,
                        ..c.caveats
                    },
                },
            })
    }

    pub fn settle(
        &mut self,
        chain: &Chain,
    ) -> Result<Landed, solana_transaction::TransactionError> {
        let payer = self.payer();
        let ixs = settle_ixs(&self.env, &payer, &self.issuer, chain, &self.winner_token);
        self.env.submit(&ixs)
    }

    /// Anyone files the loss of `losing` against the culprit's lock.
    pub fn claim(
        &mut self,
        losing: &Chain,
    ) -> Result<Landed, solana_transaction::TransactionError> {
        let ixs = claim_lost_ixs(
            &self.payer(),
            &self.culprit.lock,
            self.culprit.key.sec1(),
            0,
            &self.env.mint,
            losing,
        );
        self.env.submit(&ixs)
    }

    /// The token accounts of the cast: what a claim must leave untouched but the escrow it burns.
    pub fn balances(&self) -> Vec<(Pubkey, u64)> {
        [
            escrow_address(&self.issuer.lock),
            escrow_address(&self.culprit.lock),
            self.issuer.wallet_token,
            self.culprit.wallet_token,
            self.victim.wallet_token,
            self.winner_token,
        ]
        .into_iter()
        .map(|account| (account, self.env.balance(&account)))
        .collect()
    }

    /// Nothing but `burned` left the cast: the supply fell by it, the escrow of `lock` lost it, and
    /// no other token account changed, whoever filed the claim.
    pub fn assert_only_a_burn(
        &self,
        before: &[(Pubkey, u64)],
        supply: u64,
        lock: &Pubkey,
        burned: u64,
    ) {
        assert_eq!(
            supply - self.env.supply(),
            burned,
            "the supply fell by the burn"
        );
        let escrow = escrow_address(lock);
        for (account, balance) in before {
            let expected = if *account == escrow {
                balance - burned
            } else {
                *balance
            };
            assert_eq!(
                self.env.balance(account),
                expected,
                "token account {account}"
            );
        }
    }
}
