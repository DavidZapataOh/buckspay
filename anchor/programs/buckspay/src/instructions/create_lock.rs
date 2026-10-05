use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use buckspay_protocol::{
    lock::{MAX_LOCK, MIN_LOCK},
    NO_LOCK,
};

use crate::{
    accounting::assert_solvent,
    clock::now,
    error::BuckspayError,
    mint::validate_mint,
    payout::pay_in,
    rules::sponsor_fee_cap,
    state::{Device, Ledger, Lock, DEVICE_SEED, ESCROW_SEED, LEDGER_SEED, LOCK_SEED},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct CreateLockArgs {
    pub key: [u8; 33],
    pub lock_seq: u32,
    pub bond: u64,
    pub backing: u64,
    pub lock_until: u32,
    /// Paid by the wallet to `sponsor_token` on top of `bond + backing`; see `process`.
    pub sponsor_fee: u64,
}

#[derive(Accounts)]
#[instruction(args: CreateLockArgs)]
pub struct CreateLock<'info> {
    pub wallet: Signer<'info>,
    /// Pays the rent of the lock's three accounts and gets it back at release and close.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [DEVICE_SEED, &args.key[..1], &args.key[1..]],
        bump = device.bump,
        has_one = wallet,
    )]
    pub device: Box<Account<'info, Device>>,
    #[account(
        init,
        payer = payer,
        space = Lock::DISCRIMINATOR.len() + Lock::INIT_SPACE,
        seeds = [LOCK_SEED, &args.key[..1], &args.key[1..], &args.lock_seq.to_le_bytes()],
        bump,
    )]
    pub lock: Box<Account<'info, Lock>>,
    #[account(
        init,
        payer = payer,
        space = Ledger::DISCRIMINATOR.len() + Ledger::INIT_SPACE,
        seeds = [LEDGER_SEED, lock.key().as_ref()],
        bump,
    )]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(
        init,
        payer = payer,
        seeds = [ESCROW_SEED, lock.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = ledger,
        token::token_program = token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = wallet,
        token::token_program = token_program,
    )]
    pub funder: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = payer,
        token::token_program = token_program,
    )]
    pub sponsor_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> CreateLock<'info> {
    /// Records the lock and funds its escrow with `bond + backing` from the wallet, in this order:
    /// the mint, the sequence number, the amounts, the time window, the sponsor fee, then the state
    /// is written, then the tokens move, then the escrow is checked against the ledger.
    ///
    /// A `sponsor_fee` is allowed only on the key's first lock, when someone other than the wallet
    /// pays, at most a quarter of the funds and one whole token, to a token account of the payer.
    pub fn process(&mut self, bumps: &CreateLockBumps, args: CreateLockArgs) -> Result<()> {
        validate_mint(&self.mint.to_account_info())?;

        require!(args.lock_seq != NO_LOCK, BuckspayError::LockSeqExhausted);
        require_eq!(
            args.lock_seq,
            self.device.next_lock_seq,
            BuckspayError::LockSeqMismatch
        );
        let first_lock = self.device.next_lock_seq == 0;
        self.device.next_lock_seq = args
            .lock_seq
            .checked_add(1)
            .ok_or(BuckspayError::LockSeqExhausted)?;

        let funds = args
            .bond
            .checked_add(args.backing)
            .ok_or(BuckspayError::AmountOverflow)?;
        require!(funds > 0, BuckspayError::AmountZero);

        let remaining = args
            .lock_until
            .checked_sub(now()?)
            .ok_or(BuckspayError::LockTooShort)?;
        require!(remaining >= MIN_LOCK, BuckspayError::LockTooShort);
        require!(remaining <= MAX_LOCK, BuckspayError::LockTooLong);

        if args.sponsor_fee > 0 {
            require!(
                self.payer.key() != self.wallet.key() && first_lock && self.sponsor_token.is_some(),
                BuckspayError::FeeNotAllowed
            );
            require!(
                args.sponsor_fee <= sponsor_fee_cap(funds, self.mint.decimals),
                BuckspayError::FeeTooHigh
            );
        }

        self.lock.set_inner(Lock {
            mint: self.mint.key(),
            bond: args.bond,
            backing: args.backing,
            lock_until: args.lock_until,
            bump: bumps.lock,
        });
        self.ledger.set_inner(Ledger::new(
            args.bond,
            args.backing,
            self.payer.key(),
            args.key,
            args.lock_seq,
            bumps.ledger,
        ));

        pay_in(
            &self.funder,
            &self.escrow,
            &self.mint,
            &self.wallet,
            &self.token_program,
            funds,
        )?;
        if let (true, Some(sponsor_token)) = (args.sponsor_fee > 0, &self.sponsor_token) {
            pay_in(
                &self.funder,
                sponsor_token,
                &self.mint,
                &self.wallet,
                &self.token_program,
                args.sponsor_fee,
            )?;
        }

        self.escrow.reload()?;
        require_eq!(self.escrow.amount, funds, BuckspayError::InsufficientEscrow);
        assert_solvent(&self.ledger, self.escrow.amount)
    }
}
