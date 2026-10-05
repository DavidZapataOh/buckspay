use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use buckspay_protocol::{
    secp256r1::MAX_SIGNATURES,
    window::{self, Settle},
    Owner as NoteOwner,
};

use crate::{
    clock::now,
    error::BuckspayError,
    payout::pay_out,
    settlement::{first_unverified, load_slots, present, walk, Link, ISSUE_BODY_LEN},
    state::{Ledger, Lock, ESCROW_SEED, LEDGER_SEED, LOCK_SEED},
    verification::require_chain,
};

#[derive(Accounts)]
#[instruction(issue: [u8; ISSUE_BODY_LEN], spends: Vec<Link>)]
pub struct SettleNote<'info> {
    /// Pays the rent of the records; the fee payer in the usual case.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [LOCK_SEED, &issue[2..3], &issue[3..35], &issue[67..71]],
        bump = lock.bump,
    )]
    pub lock: Box<Account<'info, Lock>>,
    #[account(mut, seeds = [LEDGER_SEED, lock.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, lock.key().as_ref()],
        bump = lock.escrow_bump,
        token::mint = lock.mint,
        token::authority = ledger,
        token::token_program = token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = lock.mint, mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// Any token account of the mint; the handler requires its owner to be the account the note
    /// pays. The escrow is refused by the runtime's duplicate-account check as well.
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
        constraint = destination.key() != escrow.key(),
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the instructions sysvar, pinned by address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> SettleNote<'info> {
    pub fn process(
        &mut self,
        issue: &[u8; ISSUE_BODY_LEN],
        spends: &[Link],
        records: &[AccountInfo<'info>],
    ) -> Result<()> {
        require!(spends.len() < MAX_SIGNATURES, BuckspayError::TooManySpends);
        let w = walk(&crate::note_domain(), issue, spends)?;

        let i = &w.issue;
        require!(
            i.mint == self.lock.mint.to_bytes() && i.cum_end <= self.lock.backing,
            BuckspayError::WrongLock
        );
        let presented = w.settlement(issue);
        let consumed_expiry = presented[presented.len() - 1].expiry;
        match window::settle(consumed_expiry, self.lock.lock_until, now()?) {
            Settle::Open => {}
            Settle::LockEnded => return Err(error!(BuckspayError::LockEnded)),
            Settle::Closed => return Err(error!(BuckspayError::SettlementClosed)),
        }

        let output = w.last.first;
        let NoteOwner::Account(payee) = output.owner else {
            return Err(error!(BuckspayError::ChainInvalid));
        };
        require_keys_eq!(
            self.destination.owner,
            Pubkey::new_from_array(payee),
            BuckspayError::WrongPayee
        );

        let slots = load_slots(&presented, records)?;
        let start = first_unverified(&presented, &slots);
        require_chain(
            &self.instructions,
            &w.entries,
            start,
            error!(BuckspayError::ChainVerification),
        )?;

        let pay = present(
            &presented,
            slots,
            records,
            &self.payer,
            &self.system_program,
            self.lock.lock_until,
        )?;
        require!(pay, BuckspayError::ChainInvalid);
        let debit = self.ledger.pay_backing(output.amount)?;
        pay_out(
            &self.ledger,
            &self.lock.key(),
            &mut self.escrow,
            &self.mint,
            &self.destination,
            &self.token_program,
            debit,
        )
    }
}
