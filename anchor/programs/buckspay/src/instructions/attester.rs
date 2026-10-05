use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use buckspay_protocol::{
    attest::{EXIT_DELAY, MIN_STAKE_TOKENS},
    lock::TICKET_TTL_MAX,
};

use super::withdrawal::pay_out_everything;
use crate::{
    accounting::assert_solvent,
    attestation::is_prime_order_key,
    clock::now,
    error::BuckspayError,
    mint::validate_mint,
    payout::pay_in,
    rules::one_whole_token,
    state::{
        attester_status, Attester, Ledger, ATTESTER_LEDGER_MARKER, ATTESTER_SEED, ESCROW_SEED,
        LEDGER_SEED,
    },
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct RegisterAttesterArgs {
    pub id: u16,
    pub key: [u8; 32],
    pub stake: u64,
}

#[derive(Accounts)]
#[instruction(args: RegisterAttesterArgs)]
pub struct RegisterAttester<'info> {
    pub authority: Signer<'info>,
    /// Pays the rent of the attester's three accounts and gets the ledger's and the escrow's back
    /// when the stake is withdrawn.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = Attester::DISCRIMINATOR.len() + Attester::INIT_SPACE,
        seeds = [ATTESTER_SEED, &args.id.to_le_bytes()],
        bump,
    )]
    pub attester: Box<Account<'info, Attester>>,
    #[account(
        init,
        payer = payer,
        space = Ledger::DISCRIMINATOR.len() + Ledger::INIT_SPACE,
        seeds = [LEDGER_SEED, attester.key().as_ref()],
        bump,
    )]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(
        init,
        payer = payer,
        seeds = [ESCROW_SEED, attester.key().as_ref()],
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
        token::authority = authority,
        token::token_program = token_program,
    )]
    pub funder: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> RegisterAttester<'info> {
    pub fn process(
        &mut self,
        args: &RegisterAttesterArgs,
        bumps: &RegisterAttesterBumps,
    ) -> Result<()> {
        validate_mint(&self.mint.to_account_info())?;
        require!(is_prime_order_key(&args.key), BuckspayError::AttesterKey);
        let minimum = MIN_STAKE_TOKENS.saturating_mul(one_whole_token(self.mint.decimals));
        require!(args.stake >= minimum, BuckspayError::StakeTooLow);
        let now = now()?;
        self.attester.set_inner(Attester {
            id: args.id,
            authority: self.authority.key(),
            mint: self.mint.key(),
            key: args.key,
            prev_key: [0; 32],
            prev_trusted_until: 0,
            prev_until: 0,
            registered_at: now,
            status: attester_status::ACTIVE,
            exit_at: 0,
            bump: bumps.attester,
        });
        let mut marker = [0; 33];
        marker[0] = ATTESTER_LEDGER_MARKER;
        marker[1..3].copy_from_slice(&args.id.to_le_bytes());
        self.ledger.set_inner(Ledger::new(
            args.stake,
            0,
            self.payer.key(),
            marker,
            u32::from(args.id),
            bumps.ledger,
        ));
        pay_in(
            &self.funder,
            &self.escrow,
            &self.mint,
            &self.authority,
            &self.token_program,
            args.stake,
        )?;
        self.escrow.reload()?;
        require_eq!(
            self.escrow.amount,
            args.stake,
            BuckspayError::InsufficientEscrow
        );
        assert_solvent(&self.ledger, self.escrow.amount)
    }
}

#[derive(Accounts)]
pub struct TopUpAttester<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [ATTESTER_SEED, &attester.id.to_le_bytes()],
        bump = attester.bump,
        has_one = authority,
        has_one = mint,
    )]
    pub attester: Box<Account<'info, Attester>>,
    #[account(mut, seeds = [LEDGER_SEED, attester.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, attester.key().as_ref()],
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
        token::authority = authority,
        token::token_program = token_program,
    )]
    pub funder: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

impl<'info> TopUpAttester<'info> {
    pub fn process(&mut self, amount: u64) -> Result<()> {
        require!(
            self.attester.status == attester_status::ACTIVE,
            BuckspayError::AttesterStatus
        );
        self.ledger.add_stake(amount)?;
        pay_in(
            &self.funder,
            &self.escrow,
            &self.mint,
            &self.authority,
            &self.token_program,
            amount,
        )?;
        self.escrow.reload()?;
        assert_solvent(&self.ledger, self.escrow.amount)
    }
}

#[derive(Accounts)]
pub struct ManageAttester<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [ATTESTER_SEED, &attester.id.to_le_bytes()],
        bump = attester.bump,
        has_one = authority,
    )]
    pub attester: Box<Account<'info, Attester>>,
}

impl<'info> ManageAttester<'info> {
    /// Replaces the key that signs tickets. The old key stays accountable for `EXIT_DELAY`, and a
    /// second rotation waits for that. A planned rotation keeps believing the old key for the
    /// longest a ticket it signed can live; after a compromise it does not.
    pub fn rotate_key(&mut self, new_key: [u8; 32], trust_previous: bool) -> Result<()> {
        let now = now()?;
        let attester = &mut self.attester;
        require!(
            attester.status == attester_status::ACTIVE,
            BuckspayError::AttesterStatus
        );
        require!(now >= attester.prev_until, BuckspayError::RotationCooldown);
        require!(
            new_key != attester.key && is_prime_order_key(&new_key),
            BuckspayError::AttesterKey
        );
        attester.prev_key = attester.key;
        attester.prev_until = now
            .checked_add(EXIT_DELAY)
            .ok_or_else(|| error!(BuckspayError::ClockOutOfRange))?;
        attester.prev_trusted_until = if trust_previous {
            now.saturating_add(TICKET_TTL_MAX)
        } else {
            0
        };
        attester.key = new_key;
        Ok(())
    }

    pub fn request_exit(&mut self) -> Result<()> {
        require!(
            self.attester.status == attester_status::ACTIVE,
            BuckspayError::AttesterStatus
        );
        self.attester.status = attester_status::EXITING;
        self.attester.exit_at = now()?;
        Ok(())
    }

    pub fn cancel_exit(&mut self) -> Result<()> {
        require!(
            self.attester.status == attester_status::EXITING,
            BuckspayError::AttesterStatus
        );
        self.attester.status = attester_status::ACTIVE;
        self.attester.exit_at = 0;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct WithdrawAttesterStake<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [ATTESTER_SEED, &attester.id.to_le_bytes()],
        bump = attester.bump,
        has_one = authority,
        has_one = mint,
    )]
    pub attester: Box<Account<'info, Attester>>,
    #[account(
        mut,
        seeds = [LEDGER_SEED, attester.key().as_ref()],
        bump = ledger.bump,
        close = rent_receiver,
    )]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, attester.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = ledger,
        token::token_program = token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// Any token account of the mint but the escrow itself: the authority's signature names it.
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
        constraint = destination.key() != escrow.key(),
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: receives the rent of the ledger and the escrow; pinned to the account that paid it.
    #[account(mut, address = ledger.payer)]
    pub rent_receiver: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

impl<'info> WithdrawAttesterStake<'info> {
    /// `EXIT_DELAY` after the attester asked to leave or was slashed, the authority takes what is
    /// left of the stake; the ledger and the escrow close and the attester's record stays as a
    /// tombstone, so an id is never reused.
    pub fn process(&mut self) -> Result<()> {
        let status = self.attester.status;
        require!(
            status == attester_status::EXITING || status == attester_status::SLASHED,
            BuckspayError::AttesterStatus
        );
        let ready = u64::from(self.attester.exit_at) + u64::from(EXIT_DELAY);
        require!(u64::from(now()?) >= ready, BuckspayError::ExitNotReady);
        pay_out_everything(
            &mut self.ledger,
            &self.attester.key(),
            &mut self.escrow,
            &self.mint,
            &self.destination,
            &self.rent_receiver.to_account_info(),
            &self.token_program,
        )?;
        self.attester.status = attester_status::RETIRED;
        Ok(())
    }
}
