//! The ledger side of a claim, with no account or token in it so a property test can drive it for
//! any sequence of claims, settlements and withdrawals.
use anchor_lang::prelude::*;
use buckspay_protocol::slash;

use crate::{accounting::Debit, error::BuckspayError, state::Ledger};

/// Takes what a loss of `loss` burns out of the ledger's free bond: `slash::penalty`, never more
/// than the bond holds. The debit, which is never zero, must be destroyed with
/// `payout::burn_out`: no claim pays anybody.
pub fn burn_for(ledger: &mut Ledger, loss: u64) -> Result<Debit> {
    require!(loss > 0, BuckspayError::AmountZero);
    let burn = slash::penalty(loss, ledger.bond_free);
    require!(burn > 0, BuckspayError::NoBond);
    ledger.commit_slash(burn)?;
    ledger.pay_slashed(burn)
}
