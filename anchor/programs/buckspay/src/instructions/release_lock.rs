use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use buckspay_protocol::lock::{CLAIM_WINDOW, RELEASE_DELAY};

use super::withdrawal::pay_out_everything;
use crate::{
    clock::now,
    error::BuckspayError,
    state::{Device, Ledger, Lock, DEVICE_SEED, ESCROW_SEED, LEDGER_SEED, LOCK_SEED},
};

#[derive(Accounts)]
#[instruction(key: [u8; 33], lock_seq: u32)]
pub struct ReleaseLock<'info> {
    #[account(
        seeds = [DEVICE_SEED, &key[..1], &key[1..]],
        bump = device.bump,
    )]
    pub device: Box<Account<'info, Device>>,
    #[account(
        seeds = [LOCK_SEED, &key[..1], &key[1..], &lock_seq.to_le_bytes()],
        bump = lock.bump,
    )]
    pub lock: Box<Account<'info, Lock>>,
    #[account(mut, seeds = [LEDGER_SEED, lock.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, lock.key().as_ref()],
        bump,
        token::mint = lock.mint,
        token::authority = ledger,
        token::token_program = token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = lock.mint, mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// Owned by the lock's wallet: a release cannot send funds anywhere the wallet did not already
    /// control.
    #[account(
        mut,
        token::mint = mint,
        token::authority = device.wallet,
        token::token_program = token_program,
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: receives the escrow's rent; pinned to the account that paid it.
    #[account(mut, address = ledger.payer)]
    pub rent_receiver: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

impl<'info> ReleaseLock<'info> {
    /// Anyone may pay the wallet out once `RELEASE_DELAY` has passed after the withdrawal opened,
    /// so a sponsor's rent never depends on the wallet showing up.
    pub fn process(&mut self) -> Result<()> {
        let opens =
            u64::from(self.lock.lock_until) + u64::from(CLAIM_WINDOW) + u64::from(RELEASE_DELAY);
        require!(u64::from(now()?) >= opens, BuckspayError::ReleaseTooEarly);
        pay_out_everything(
            &mut self.ledger,
            &self.lock.key(),
            &mut self.escrow,
            &self.mint,
            &self.destination,
            &self.rent_receiver.to_account_info(),
            &self.token_program,
        )
    }
}
