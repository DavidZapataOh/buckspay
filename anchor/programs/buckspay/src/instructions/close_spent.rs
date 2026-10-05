use anchor_lang::prelude::*;

use crate::{clock::now, error::BuckspayError, state::Spent};

/// Closes records whose retention has passed and returns their rent to whoever paid it. The
/// accounts are pairs `(spent, rent_receiver)`. A pair whose first account is no longer a record
/// (somebody closed it first) is skipped, so one closed record cannot make a batch revert.
#[derive(Accounts)]
pub struct CloseSpent {}

impl CloseSpent {
    pub fn process<'info>(remaining: &'info [AccountInfo<'info>]) -> Result<()> {
        require!(
            !remaining.is_empty() && remaining.len().is_multiple_of(2),
            BuckspayError::RecordAccounts
        );
        let now = now()?;
        for pair in remaining.chunks_exact(2) {
            let (record, receiver) = (&pair[0], &pair[1]);
            if record.owner != &crate::ID || record.data_is_empty() {
                continue;
            }
            let spent = Account::<Spent>::try_from(record)?;
            require_keys_eq!(receiver.key(), spent.payer, BuckspayError::RecordAccounts);
            require!(now >= spent.closable_at, BuckspayError::RecordNotClosable);
            spent.close(receiver.clone())?;
        }
        Ok(())
    }
}
