use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use buckspay_protocol::lock::CLAIM_WINDOW;

use super::withdrawal::pay_out_everything;
use crate::{
    clock::now,
    error::BuckspayError,
    state::{Device, Ledger, Lock, DEVICE_SEED, ESCROW_SEED, LEDGER_SEED, LOCK_SEED},
};

#[derive(Accounts)]
#[instruction(key: [u8; 33], lock_seq: u32)]
pub struct WithdrawLock<'info> {
    pub wallet: Signer<'info>,
    #[account(
        seeds = [DEVICE_SEED, &key[..1], &key[1..]],
        bump = device.bump,
        has_one = wallet,
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
    /// Any token account of the mint but the escrow itself: the wallet's signature names it.
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
        constraint = destination.key() != escrow.key(),
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: receives the escrow's rent; pinned to the account that paid it.
    #[account(mut, address = ledger.payer)]
    pub rent_receiver: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

impl<'info> WithdrawLock<'info> {
    /// From `lock_until + CLAIM_WINDOW` the current wallet takes what the ledger does not owe to
    /// claims. May be repeated to sweep what was donated or released since.
    pub fn process(&mut self) -> Result<()> {
        let opens = u64::from(self.lock.lock_until) + u64::from(CLAIM_WINDOW);
        require!(u64::from(now()?) >= opens, BuckspayError::WithdrawTooEarly);
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
