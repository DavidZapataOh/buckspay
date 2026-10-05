//! Harness for the attester tests: operators, tickets, the Ed25519 verification instruction and the
//! builders of every attester instruction.
#![allow(dead_code)]
use anchor_lang::{
    prelude::Pubkey,
    solana_program::instruction::{AccountMeta, Instruction},
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use buckspay::{state::Attester, RegisterAttesterArgs, ATTESTER_SEED};
use buckspay_protocol::BondTicket;
use ed25519_dalek::{Signer as _, SigningKey};
use solana_account::ReadableAccount;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::TransactionError;

use super::*;

/// 1,000 whole tokens of a six-decimal mint.
pub const STAKE: u64 = 1_000_000_000;

pub fn attester_address(id: u16) -> Pubkey {
    Pubkey::find_program_address(&[ATTESTER_SEED, &id.to_le_bytes()], &buckspay::ID).0
}

pub fn signing(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

pub fn public(key: &SigningKey) -> [u8; 32] {
    key.verifying_key().to_bytes()
}

/// The inline Ed25519 verification `new_ed25519_instruction_with_signature` builds: public key,
/// signature, message, every instruction index `u16::MAX`.
pub fn ed25519_data(key: &[u8; 32], signature: &[u8; 64], message: &[u8]) -> Vec<u8> {
    let mut data = vec![1u8, 0];
    for field in [
        48u16,
        u16::MAX,
        16,
        u16::MAX,
        112,
        message.len() as u16,
        u16::MAX,
    ] {
        data.extend_from_slice(&field.to_le_bytes());
    }
    data.extend_from_slice(key);
    data.extend_from_slice(signature);
    data.extend_from_slice(message);
    data
}

pub fn ed25519_ix(key: &[u8; 32], signature: &[u8; 64], message: &[u8]) -> Instruction {
    Instruction {
        program_id: solana_sdk_ids::ed25519_program::ID,
        accounts: vec![],
        data: ed25519_data(key, signature, message),
    }
}

/// An attester's authority and signing key, with a token account that holds its funds.
pub struct Operator {
    pub id: u16,
    pub authority: Keypair,
    pub key: SigningKey,
    pub token: Pubkey,
    pub address: Pubkey,
}

impl Operator {
    pub fn public(&self) -> [u8; 32] {
        public(&self.key)
    }

    pub fn ledger(&self) -> Pubkey {
        ledger_address(&self.address)
    }

    pub fn escrow(&self) -> Pubkey {
        escrow_address(&self.address)
    }

    /// A ticket for a lock, signed by the attester's key.
    pub fn ticket(&self, fields: TicketFields) -> BondTicket {
        self.sign_with(&self.key, fields)
    }

    /// The same ticket signed by `key`, which need not be the attester's.
    pub fn sign_with(&self, key: &SigningKey, fields: TicketFields) -> BondTicket {
        let mut ticket = BondTicket {
            device: fields.device,
            mint: fields.mint,
            lock_seq: fields.lock_seq,
            bond: fields.bond,
            backing: fields.backing,
            lock_until: fields.lock_until,
            valid_until: fields.valid_until,
            attester: self.id,
            signature: [0; 64],
        };
        ticket.signature = key
            .sign(&ticket.signed_message(&buckspay::ticket_domain()))
            .to_bytes();
        ticket
    }
}

#[derive(Clone, Copy)]
pub struct TicketFields {
    pub device: [u8; 33],
    pub mint: [u8; 32],
    pub lock_seq: u32,
    pub bond: u64,
    pub backing: u64,
    pub lock_until: u32,
    pub valid_until: u32,
}

impl TicketFields {
    /// What an honest attester signs for `lock` of `user`.
    pub fn of(env: &Env, user: &User, lock: &Lock) -> Self {
        Self {
            device: user.key.sec1(),
            mint: env.mint.to_bytes(),
            lock_seq: lock.seq,
            bond: lock.bond,
            backing: lock.backing,
            lock_until: lock.until,
            valid_until: env.now() + DAY_SECONDS,
        }
    }

    /// A ticket for a lock of an unregistered device: nothing was ever created.
    pub fn phantom(env: &Env, device: [u8; 33]) -> Self {
        Self {
            device,
            mint: env.mint.to_bytes(),
            lock_seq: 0,
            bond: 400_000_000,
            backing: 1_000_000_000,
            lock_until: env.now() + 40 * DAY_SECONDS,
            valid_until: env.now() + DAY_SECONDS,
        }
    }
}

pub const DAY_SECONDS: u32 = 86_400;

impl Env {
    pub fn attester(&self, address: &Pubkey) -> Attester {
        let account = self.svm.get_account(address).unwrap();
        Attester::try_deserialize(&mut account.data()).unwrap()
    }

    pub fn try_attester(&self, address: &Pubkey) -> Option<Attester> {
        let account = self.svm.get_account(address)?;
        (!account.data().is_empty())
            .then(|| Attester::try_deserialize(&mut account.data()).unwrap())
    }

    /// An authority with lamports and ten stakes of tokens, and an unregistered attester id.
    pub fn operator(&mut self, id: u16, seed: u8) -> Operator {
        let funded = self.unregistered_user(10 * STAKE);
        self.svm
            .airdrop(&funded.wallet.pubkey(), 10_000_000_000)
            .unwrap();
        Operator {
            id,
            authority: funded.wallet,
            key: signing(seed),
            token: funded.token,
            address: attester_address(id),
        }
    }

    pub fn registered(&mut self, id: u16, seed: u8, stake: u64) -> Operator {
        let operator = self.operator(id, seed);
        self.register_attester(&operator, &operator.public(), stake)
            .unwrap();
        operator
    }

    pub fn register_attester(
        &mut self,
        operator: &Operator,
        key: &[u8; 32],
        stake: u64,
    ) -> Result<Landed, TransactionError> {
        let ix = register_attester_ix(self, operator, key, stake);
        self.send(&operator.authority, &[ix])
    }

    pub fn send_operator(
        &mut self,
        operator: &Operator,
        ixs: &[Instruction],
    ) -> Result<Landed, TransactionError> {
        self.send(&operator.authority, ixs)
    }
}

pub fn register_attester_ix(
    env: &Env,
    operator: &Operator,
    key: &[u8; 32],
    stake: u64,
) -> Instruction {
    Instruction {
        program_id: buckspay::ID,
        accounts: buckspay::accounts::RegisterAttester {
            authority: operator.authority.pubkey(),
            payer: operator.authority.pubkey(),
            attester: operator.address,
            ledger: operator.ledger(),
            escrow: operator.escrow(),
            mint: env.mint,
            funder: operator.token,
            token_program: env.token_program,
            system_program: solana_sdk_ids::system_program::ID,
        }
        .to_account_metas(None),
        data: buckspay::instruction::RegisterAttester {
            args: RegisterAttesterArgs {
                id: operator.id,
                key: *key,
                stake,
            },
        }
        .data(),
    }
}

pub fn top_up_ix(env: &Env, operator: &Operator, amount: u64) -> Instruction {
    Instruction {
        program_id: buckspay::ID,
        accounts: buckspay::accounts::TopUpAttester {
            authority: operator.authority.pubkey(),
            attester: operator.address,
            ledger: operator.ledger(),
            escrow: operator.escrow(),
            mint: env.mint,
            funder: operator.token,
            token_program: env.token_program,
        }
        .to_account_metas(None),
        data: buckspay::instruction::TopUpAttester { amount }.data(),
    }
}

fn manage_accounts(authority: &Pubkey, attester: &Pubkey) -> Vec<AccountMeta> {
    buckspay::accounts::ManageAttester {
        authority: *authority,
        attester: *attester,
    }
    .to_account_metas(None)
}

pub fn rotate_ix(operator: &Operator, new_key: &[u8; 32], trust_previous: bool) -> Instruction {
    Instruction {
        program_id: buckspay::ID,
        accounts: manage_accounts(&operator.authority.pubkey(), &operator.address),
        data: buckspay::instruction::RotateAttesterKey {
            new_key: *new_key,
            trust_previous,
        }
        .data(),
    }
}

pub fn request_exit_ix(authority: &Pubkey, attester: &Pubkey) -> Instruction {
    Instruction {
        program_id: buckspay::ID,
        accounts: manage_accounts(authority, attester),
        data: buckspay::instruction::RequestAttesterExit {}.data(),
    }
}

pub fn cancel_exit_ix(authority: &Pubkey, attester: &Pubkey) -> Instruction {
    Instruction {
        program_id: buckspay::ID,
        accounts: manage_accounts(authority, attester),
        data: buckspay::instruction::CancelAttesterExit {}.data(),
    }
}

pub fn withdraw_stake_ix(
    env: &Env,
    operator: &Operator,
    destination: &Pubkey,
    rent_receiver: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: buckspay::ID,
        accounts: buckspay::accounts::WithdrawAttesterStake {
            authority: operator.authority.pubkey(),
            attester: operator.address,
            ledger: operator.ledger(),
            escrow: operator.escrow(),
            mint: env.mint,
            destination: *destination,
            rent_receiver: *rent_receiver,
            token_program: env.token_program,
        }
        .to_account_metas(None),
        data: buckspay::instruction::WithdrawAttesterStake {}.data(),
    }
}

/// The Ed25519 verification of `ticket`'s signature by `key`, then the report.
pub fn report_ixs(
    env: &Env,
    reporter: &Pubkey,
    ticket: &BondTicket,
    key: &[u8; 32],
) -> Vec<Instruction> {
    let message = ticket.signed_message(&buckspay::ticket_domain());
    vec![
        ed25519_ix(key, &ticket.signature, &message),
        report_ix(env, reporter, ticket),
    ]
}

pub fn report_ix(env: &Env, reporter: &Pubkey, ticket: &BondTicket) -> Instruction {
    let attester = attester_address(ticket.attester);
    Instruction {
        program_id: buckspay::ID,
        accounts: buckspay::accounts::ReportFalseTicket {
            reporter: *reporter,
            attester,
            ledger: ledger_address(&attester),
            escrow: escrow_address(&attester),
            mint: env.mint,
            device: device_address(&ticket.device),
            lock: lock_address(&ticket.device, ticket.lock_seq),
            instructions: solana_instructions_sysvar::ID,
            token_program: env.token_program,
        }
        .to_account_metas(None),
        data: buckspay::instruction::ReportFalseTicket {
            ticket: ticket.encode(),
        }
        .data(),
    }
}
