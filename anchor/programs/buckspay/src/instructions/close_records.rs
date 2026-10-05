use anchor_lang::prelude::*;

use crate::{clock::now, error::BuckspayError, state::Claim};

/// Closes claims whose retention has passed and returns their rent to whoever paid it. The
/// accounts are pairs `(claim, rent_receiver)`.
#[derive(Accounts)]
pub struct CloseRecords {}

impl CloseRecords {
    pub fn process<'info>(remaining: &'info [AccountInfo<'info>]) -> Result<()> {
        require!(
            !remaining.is_empty() && remaining.len().is_multiple_of(2),
            BuckspayError::RecordAccounts
        );
        let now = now()?;
        for pair in remaining.chunks_exact(2) {
            let (record, receiver) = (&pair[0], &pair[1]);
            let claim = Account::<Claim>::try_from(record)?;
            require_keys_eq!(receiver.key(), claim.payer, BuckspayError::RecordAccounts);
            require!(now >= claim.closable_at, BuckspayError::RecordNotClosable);
            claim.close(receiver.clone())?;
        }
        Ok(())
    }
}
