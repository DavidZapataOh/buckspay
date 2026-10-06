use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use buckspay_protocol::{chain, slash, window, Owner as NoteOwner};

use crate::{
    clock::now,
    error::BuckspayError,
    filing::{self, Filing},
    records::RECLAIMED,
    settlement::{walk, Link, ISSUE_BODY_LEN, MAX_CHAIN_SPENDS},
    spent,
    state::{Ledger, Lock, ESCROW_SEED, LEDGER_SEED, LOCK_SEED},
    verification::require_chain,
};

/// The chain of a branch that lost: the issue and the spends up to and including the culprit's, the
/// last spend. The loss claimed is the culprit's payment, output 0 of that spend. `lock_key` and
/// `lock_seq` name the lock that backed it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct LostSpend {
    pub issue: [u8; ISSUE_BODY_LEN],
    pub spends: Vec<Link>,
    pub lock_key: [u8; 33],
    pub lock_seq: u32,
}

#[derive(Accounts)]
#[instruction(lost: LostSpend)]
pub struct ClaimLostSpend<'info> {
    /// Anyone: the claim pays nobody, so nobody needs standing to file it.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [LOCK_SEED, &lost.lock_key[..1], &lost.lock_key[1..], &lost.lock_seq.to_le_bytes()],
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
    /// CHECK: the record of the contested output, read at its derived address.
    pub record: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar, pinned by address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> ClaimLostSpend<'info> {
    pub fn process(&mut self, lost: &LostSpend) -> Result<()> {
        require!(
            lost.spends.len() <= MAX_CHAIN_SPENDS,
            BuckspayError::TooManySpends
        );
        require!(!lost.spends.is_empty(), BuckspayError::ChainInvalid);
        let domain = crate::note_domain();
        let w = walk(&domain, &lost.issue, &lost.spends)?;
        let n = w.consumed.len();
        let contested = &w.consumed[n - 1];
        let input = w
            .contested
            .ok_or_else(|| error!(BuckspayError::ChainInvalid))?;
        let (culprit, culprit_envelope) = w.entries[n];
        let payment = w.last.first;
        require!(
            payment.owner != NoteOwner::Device(culprit),
            BuckspayError::NotClaimable
        );
        require!(
            w.issue.mint == self.lock.mint.to_bytes(),
            BuckspayError::WrongLock
        );

        // The winner is whatever the record holds: a different content than the claimed branch's,
        // and not a reclaim, which is no spend.
        let record = spent::read(&self.record, &contested.output)?
            .ok_or_else(|| error!(BuckspayError::NoRecord))?;
        require!(record.flags & RECLAIMED == 0, BuckspayError::NotClaimable);
        require!(
            record.content != contested.content,
            BuckspayError::NotConflicting
        );

        // Which lock answers for the culprit's spend: the one it named, or the chain's when the
        // output was delegated. A settlement of a plain output has no lock to blame: no receiver
        // accepted it offline, so nobody was defrauded.
        let earlier: Vec<([u8; 33], u32)> = w.entries[1..n]
            .iter()
            .zip(&w.spends)
            .map(|((key, _), spend)| (*key, spend.lock_seq))
            .collect();
        let liable = chain::backer(
            &w.issue.issuer,
            w.issue.lock_seq,
            &earlier,
            &culprit,
            w.spends[n - 1].lock_seq,
            chain::unlocked(&input.caveats.for_holder(&input.owner)),
        )
        .ok_or_else(|| error!(BuckspayError::NotClaimable))?;
        require!(
            liable == (lost.lock_key, lost.lock_seq),
            BuckspayError::ConflictProof
        );
        // Only what a receiver could have accepted on the strength of this lock is a loss of it.
        require!(
            slash::covers(self.lock.bond, input.amount),
            BuckspayError::OverCoverage
        );

        let now = now()?;
        require!(now < self.lock.lock_until, BuckspayError::LockEnded);
        require!(
            u64::from(now) <= window::report_deadline(record.expiry),
            BuckspayError::ClaimTooLate
        );
        require_chain(
            &self.instructions,
            &[(culprit, culprit_envelope)],
            0,
            error!(BuckspayError::ChainVerification),
        )?;

        let closable_at = u32::try_from(window::claim_closable_at(
            record.expiry,
            self.lock.lock_until,
        ))
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
            &payment.id,
            payment.amount,
            closable_at,
        )
    }
}
