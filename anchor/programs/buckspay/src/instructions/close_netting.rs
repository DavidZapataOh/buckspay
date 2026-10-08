use anchor_lang::prelude::*;

use crate::{clock::now, error::BuckspayError, netting::Netting};

/// Closes a record whose keep window has passed and returns its rent to whoever paid it. Anyone may send it.
#[derive(Accounts)]
pub struct CloseNetting<'info> {
    #[account(mut, close = payer)]
    pub netting: Account<'info, Netting>,
    /// CHECK: receives the rent; pinned to the payer the record names.
    #[account(mut, address = netting.payer)]
    pub payer: UncheckedAccount<'info>,
}

impl CloseNetting<'_> {
    pub fn process(&self) -> Result<()> {
        require!(
            now()? >= self.netting.closable_at,
            BuckspayError::NettingOpen
        );
        Ok(())
    }
}
