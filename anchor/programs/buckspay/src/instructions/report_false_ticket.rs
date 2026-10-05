use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use buckspay_protocol::{
    attest::{falsity, Falsity},
    BondTicket,
};

use crate::{
    attestation::{read_counter, read_lock, require_ticket_signature},
    clock::now,
    error::BuckspayError,
    filing,
    state::{
        attester_status, Attester, Ledger, ATTESTER_SEED, DEVICE_SEED, ESCROW_SEED, LEDGER_SEED,
        LOCK_SEED,
    },
};

#[derive(Accounts)]
#[instruction(ticket: [u8; BondTicket::WIRE_LEN])]
pub struct ReportFalseTicket<'info> {
    /// Anyone: the report pays nobody, so nobody needs standing to file it.
    pub reporter: Signer<'info>,
    #[account(
        mut,
        seeds = [ATTESTER_SEED, &ticket[95..97]],
        bump = attester.bump,
    )]
    pub attester: Box<Account<'info, Attester>>,
    #[account(mut, seeds = [LEDGER_SEED, attester.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, attester.key().as_ref()],
        bump,
        token::mint = attester.mint,
        token::authority = ledger,
        token::token_program = token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Writable because the burn lowers its supply.
    #[account(mut, address = attester.mint, mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the ticket's device at its seeds, absent if it was never registered; read by the
    /// handler.
    #[account(seeds = [DEVICE_SEED, &ticket[2..3], &ticket[3..35]], bump)]
    pub device: UncheckedAccount<'info>,
    /// CHECK: the ticket's lock at its seeds, absent if it never existed or was closed; read by the
    /// handler.
    #[account(seeds = [LOCK_SEED, &ticket[2..3], &ticket[3..35], &ticket[67..71]], bump)]
    pub lock: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar, pinned by address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

impl<'info> ReportFalseTicket<'info> {
    /// A ticket the chain contradicts, signed by a key the attester answers for, destroys the
    /// attester's whole free stake and ends its standing: its status becomes `Slashed` for good.
    /// Only the accounts decide: the lock and the device's counter, and the clock for a closed lock.
    pub fn process(&mut self, ticket: &[u8; BondTicket::WIRE_LEN]) -> Result<()> {
        let ticket =
            BondTicket::decode(ticket).map_err(|_| error!(BuckspayError::TicketBinding))?;
        let now = now()?;
        match self.attester.status {
            attester_status::ACTIVE | attester_status::EXITING => {}
            attester_status::SLASHED => return err!(BuckspayError::AlreadySlashed),
            _ => return err!(BuckspayError::AttesterStatus),
        }
        require_ticket_signature(
            &self.instructions,
            &ticket,
            &self.attester.accountable_keys(now),
        )?;
        let lock = read_lock(&self.lock)?;
        let counter = read_counter(&self.device)?;
        require!(
            falsity(&ticket, lock.as_ref(), counter, u64::from(now)) != Falsity::NotFalse,
            BuckspayError::TicketNotProvablyFalse
        );
        filing::burn_stake(
            &mut self.ledger,
            &self.attester.key(),
            &mut self.escrow,
            &self.mint,
            &self.token_program,
        )?;
        if self.attester.status == attester_status::ACTIVE {
            self.attester.exit_at = now;
        }
        self.attester.status = attester_status::SLASHED;
        Ok(())
    }
}
