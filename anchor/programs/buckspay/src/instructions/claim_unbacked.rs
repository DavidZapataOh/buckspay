use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use buckspay_protocol::{slash, window, Owner as NoteOwner};

use crate::{
    clock::now,
    error::BuckspayError,
    filing::{self, Filing},
    records::{Role, PAID},
    settlement::{walk, Link, ISSUE_BODY_LEN},
    spent,
    state::{Ledger, Lock, ESCROW_SEED, LEDGER_SEED, LOCK_SEED},
    verification::require_chain,
};

#[derive(Accounts)]
#[instruction(issue: [u8; ISSUE_BODY_LEN], spends: Vec<Link>)]
pub struct ClaimUnbacked<'info> {
    /// Anyone: the claim pays nobody, so nobody needs standing to file it.
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
    /// Writable because the burn lowers its supply.
    #[account(mut, address = lock.mint, mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the claim of the lost output; its address is derived and checked by the handler,
    /// which creates it.
    #[account(mut)]
    pub claim: UncheckedAccount<'info>,
    /// CHECK: the record of the claimed output, read at its derived address.
    pub record: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar, pinned by address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> ClaimUnbacked<'info> {
    /// A chain the issuer's backing cannot pay burns the issuer's bond for the loss of its last
    /// output. The remaining accounts are the records of the outputs the chain consumed, in order,
    /// as a settlement would present them: an issuer that signs disjoint intervals inside the
    /// backing never leaves a chain unpaid unless a sibling branch of it was paid, and every
    /// record says so. Only a chain that no record contradicts is proof of overlapping intervals.
    /// Nothing is written to the records: the claim is the claim account and the burn.
    pub fn process(
        &mut self,
        issue: &[u8; ISSUE_BODY_LEN],
        spends: &[Link],
        records: &[AccountInfo<'info>],
    ) -> Result<()> {
        let w = walk(&crate::note_domain(), issue, spends)?;
        let output = w.last.first;
        require!(
            w.issue.mint == self.lock.mint.to_bytes() && w.issue.cum_end <= self.lock.backing,
            BuckspayError::WrongLock
        );
        // A receiver refuses an issue its issuer's bond does not cover, so no receiver lost it.
        require!(
            slash::covers(self.lock.bond, w.issue.amount),
            BuckspayError::OverCoverage
        );
        require!(
            self.ledger.backing_left < output.amount,
            BuckspayError::NotClaimable
        );

        // What a settlement of the chain would present: an account holds the chain's payment
        // through a final spend, a device key holds an output nobody has consumed.
        let presented = match output.owner {
            NoteOwner::Account(_) => w.settlement(issue),
            NoteOwner::Device(_) => w.prefixes(),
        };
        require_eq!(
            records.len(),
            presented.len(),
            BuckspayError::RecordAccounts
        );
        for (item, account) in presented.iter().zip(records) {
            if let Some(record) = spent::read(account, &item.output)? {
                require!(record.content == item.content, BuckspayError::NotClaimable);
                require!(
                    item.role != Role::Final || record.flags & PAID == 0,
                    BuckspayError::NotClaimable
                );
            }
        }
        let expiry = match output.owner {
            NoteOwner::Account(_) => presented[presented.len() - 1].expiry,
            NoteOwner::Device(_) => {
                require!(
                    spent::read(&self.record, &output.id)?.is_none(),
                    BuckspayError::NotClaimable
                );
                output.caveats.expiry
            }
        };

        let now = now()?;
        require!(now < self.lock.lock_until, BuckspayError::LockEnded);
        require!(
            u64::from(now) <= window::report_deadline(expiry),
            BuckspayError::ClaimTooLate
        );
        require_chain(
            &self.instructions,
            &w.entries,
            0,
            error!(BuckspayError::ChainVerification),
        )?;

        let closable_at = u32::try_from(window::claim_closable_at(expiry, self.lock.lock_until))
            .map_err(|_| error!(BuckspayError::ClockOutOfRange))?;
        filing::file(
            Filing {
                lock_address: &self.lock.key(),
                ledger: &mut self.ledger,
                escrow: &mut self.escrow,
                mint: &self.mint,
                token_program: &self.token_program,
                claim: &self.claim,
                payer: &self.payer,
                system_program: &self.system_program,
            },
            &output.id,
            output.amount,
            closable_at,
        )
    }
}
