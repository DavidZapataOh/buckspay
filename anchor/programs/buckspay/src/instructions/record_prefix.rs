use anchor_lang::prelude::*;
use buckspay_protocol::window::{self, Settle};

use crate::{
    clock::now,
    error::BuckspayError,
    settlement::{
        check_signature_budget, first_unverified, load_slots, present, walk, Link, ISSUE_BODY_LEN,
        MAX_CHAIN_SPENDS,
    },
    state::{Lock, LOCK_SEED},
    verification::require_chain,
};

/// Records the consumed outputs of a chain without paying anyone, so that a later settlement of
/// the chain needs the signature of its last message only.
#[derive(Accounts)]
#[instruction(issue: [u8; ISSUE_BODY_LEN], spends: Vec<Link>)]
pub struct RecordPrefix<'info> {
    /// Pays the rent of the records.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [LOCK_SEED, &issue[2..3], &issue[3..35], &issue[67..71]],
        bump = lock.bump,
    )]
    pub lock: Box<Account<'info, Lock>>,
    /// CHECK: the instructions sysvar, pinned by address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> RecordPrefix<'info> {
    pub fn process(
        &mut self,
        issue: &[u8; ISSUE_BODY_LEN],
        spends: &[Link],
        records: &[AccountInfo<'info>],
    ) -> Result<()> {
        require!(
            !spends.is_empty() && spends.len() <= MAX_CHAIN_SPENDS,
            BuckspayError::TooManySpends
        );
        let w = walk(&crate::note_domain(), issue, spends)?;

        let i = &w.issue;
        require!(
            i.mint == self.lock.mint.to_bytes() && i.cum_end <= self.lock.backing,
            BuckspayError::WrongLock
        );
        let presented = w.prefixes();
        let consumed_expiry = presented[presented.len() - 1].expiry;
        match window::settle(consumed_expiry, self.lock.lock_until, now()?) {
            Settle::Open => {}
            Settle::LockEnded => return Err(error!(BuckspayError::LockEnded)),
            Settle::Closed => return Err(error!(BuckspayError::SettlementClosed)),
        }

        let slots = load_slots(&presented, records)?;
        let start = first_unverified(&presented, &slots);
        check_signature_budget(w.entries.len(), start)?;
        require_chain(
            &self.instructions,
            &w.entries,
            start,
            error!(BuckspayError::ChainVerification),
        )?;
        present(
            &presented,
            slots,
            records,
            &self.payer,
            &self.system_program,
            self.lock.lock_until,
        )?;
        Ok(())
    }
}
