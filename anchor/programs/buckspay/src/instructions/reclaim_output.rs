use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use buckspay_protocol::{
    reclaim::{reclaim_envelope, record_content},
    secp256r1::MAX_SIGNATURES,
    window::{self, Reclaim},
    Owner as NoteOwner,
};

use crate::{
    clock::now,
    error::BuckspayError,
    payout::pay_out,
    records::Role,
    settlement::{load_slots, present, walk, Link, Presented, ISSUE_BODY_LEN},
    state::{Device, Ledger, Lock, DEVICE_SEED, ESCROW_SEED, LEDGER_SEED, LOCK_SEED},
    verification::require_chain,
};

#[derive(Accounts)]
#[instruction(owner: [u8; 33], issue: [u8; ISSUE_BODY_LEN], spends: Vec<Link>, which: u8, deadline: u32)]
pub struct ReclaimOutput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [DEVICE_SEED, &owner[..1], &owner[1..]],
        bump = device.bump,
    )]
    pub device: Box<Account<'info, Device>>,
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
    /// Owned by the wallet the owner's key is bound to: a reclaim cannot send funds anywhere the
    /// wallet did not already control.
    #[account(
        mut,
        token::mint = mint,
        token::authority = device.wallet,
        token::token_program = token_program,
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the instructions sysvar, pinned by address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> ReclaimOutput<'info> {
    pub fn process(
        &mut self,
        owner: &[u8; 33],
        issue: &[u8; ISSUE_BODY_LEN],
        spends: &[Link],
        which: u8,
        deadline: u32,
        records: &[AccountInfo<'info>],
    ) -> Result<()> {
        require!(
            spends.len() + 1 < MAX_SIGNATURES,
            BuckspayError::TooManySpends
        );
        let mut w = walk(&crate::note_domain(), issue, spends)?;
        let output = match which {
            0 => w.last.first,
            1 => w
                .last
                .second
                .ok_or_else(|| error!(BuckspayError::ChainInvalid))?,
            _ => return Err(error!(BuckspayError::ChainInvalid)),
        };
        require!(
            output.owner == NoteOwner::Device(*owner),
            BuckspayError::ChainInvalid
        );
        w.entries.push((
            *owner,
            reclaim_envelope(&crate::reclaim_domain(), &output.id, deadline),
        ));
        require_chain(
            &self.instructions,
            &w.entries,
            0,
            error!(BuckspayError::ChainVerification),
        )?;

        let i = &w.issue;
        require!(
            i.mint == self.lock.mint.to_bytes() && i.cum_end <= self.lock.backing,
            BuckspayError::WrongLock
        );
        let now = now()?;
        match window::reclaim(output.caveats.expiry, self.lock.lock_until, now) {
            Reclaim::Open => {}
            Reclaim::LockEnded => return Err(error!(BuckspayError::LockEnded)),
            Reclaim::TooEarly => return Err(error!(BuckspayError::ReclaimTooEarly)),
            Reclaim::Closed => return Err(error!(BuckspayError::ReclaimClosed)),
        }
        require!(now <= deadline, BuckspayError::ReclaimExpired);

        let mut presented = w.prefixes();
        presented.push(Presented {
            output: output.id,
            content: record_content(),
            expiry: output.caveats.expiry,
            role: Role::Reclaim,
            message: None,
        });
        let slots = load_slots(&presented, records)?;
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
