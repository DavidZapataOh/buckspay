use anchor_lang::prelude::*;

use crate::{channel::Channel, clock::now, error::BuckspayError};

#[derive(Accounts)]
pub struct CloseChannel<'info> {
    #[account(mut, close = payer, has_one = payer)]
    pub channel: Account<'info, Channel>,
    /// Gets the rent of the channel back, whoever closes it.
    #[account(mut)]
    pub payer: SystemAccount<'info>,
}

impl CloseChannel<'_> {
    pub fn process(&self) -> Result<()> {
        require!(
            now()? >= self.channel.closable_at,
            BuckspayError::ChannelStillOpen
        );
        Ok(())
    }
}
