use anchor_lang::{
    prelude::*,
    system_program::{self, Transfer},
};
use buckspay_protocol::lock::RECORD_TTL;

use crate::{
    clock::now,
    error::BuckspayError,
    refund::refund_target,
    state::{Ledger, Lock, ESCROW_SEED, LEDGER_SEED, LOCK_SEED},
};

#[derive(Accounts)]
#[instruction(key: [u8; 33], lock_seq: u32)]
pub struct CloseLock<'info> {
    #[account(
        mut,
        seeds = [LOCK_SEED, &key[..1], &key[1..], &lock_seq.to_le_bytes()],
        bump = lock.bump,
    )]
    pub lock: Box<Account<'info, Lock>>,
    #[account(
        mut,
        seeds = [LEDGER_SEED, lock.key().as_ref()],
        bump = ledger.bump,
    )]
    pub ledger: Box<Account<'info, Ledger>>,
    /// CHECK: the escrow's address; the handler requires it to be a closed (system-owned, empty)
    /// account, which anyone may have sent lamports to.
    #[account(mut, seeds = [ESCROW_SEED, lock.key().as_ref()], bump)]
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: pinned to the account that paid the rent.
    #[account(mut, address = ledger.payer)]
    pub rent_receiver: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> CloseLock<'info> {
    /// Closes `Lock` and `Ledger` to whoever paid them, once the lock is withdrawn, its pool is
    /// paid, its escrow is gone and `RECORD_TTL` has passed since `lock_until`. Lamports someone
    /// sent to the dead escrow address go to the payer too. If the payer can no longer take
    /// lamports, everything rests at the dead escrow address instead.
    pub fn process(&mut self, bumps: &CloseLockBumps) -> Result<()> {
        require!(self.ledger.withdrawn, BuckspayError::NotWithdrawn);
        require!(self.ledger.bond_slashed == 0, BuckspayError::SlashPending);
        require!(
            self.escrow.owner == &system_program::ID && self.escrow.data_is_empty(),
            BuckspayError::EscrowOpen
        );
        let opens = u64::from(self.lock.lock_until) + u64::from(RECORD_TTL);
        require!(u64::from(now()?) >= opens, BuckspayError::CloseTooEarly);

        let escrow = self.escrow.to_account_info();
        let receiver = self.rent_receiver.to_account_info();
        let target = refund_target(&receiver, &escrow);

        let gift = escrow.lamports();
        if gift > 0 && target.key != escrow.key {
            system_program::transfer(
                CpiContext::new_with_signer(
                    self.system_program.key(),
                    Transfer {
                        from: escrow.clone(),
                        to: target.clone(),
                    },
                    &[&[ESCROW_SEED, self.lock.key().as_ref(), &[bumps.escrow]]],
                ),
                gift,
            )?;
        }
        self.lock.close(target.clone())?;
        self.ledger.close(target.clone())
    }
}
