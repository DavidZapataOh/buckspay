use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    payout::{close_escrow, pay_out},
    refund::refund_target,
    state::Ledger,
};

/// Pays everything the ledger does not owe elsewhere to `destination`, and closes the escrow if
/// that empties it or finds it empty. The shape every payout has: the ledger method first, then the
/// one transfer. The escrow's rent goes to `rent_receiver`, or to the ledger if that account can no
/// longer take lamports (see `refund_target`), so the payout never depends on it.
pub(crate) fn pay_out_everything<'info>(
    ledger: &mut Account<'info, Ledger>,
    lock: &Pubkey,
    escrow: &mut InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    destination: &InterfaceAccount<'info, TokenAccount>,
    rent_receiver: &AccountInfo<'info>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    let debit = ledger.drain(escrow.amount)?;
    // A debit of nothing (the pool is all that is left, or everything was already paid out) has no
    // transfer to carry, but the escrow may still be empty and have to be closed.
    if debit.amount() > 0 {
        pay_out(
            ledger,
            lock,
            escrow,
            mint,
            destination,
            token_program,
            debit,
        )?;
    }
    if escrow.amount == 0 {
        let ledger_info = ledger.to_account_info();
        let target = refund_target(rent_receiver, &ledger_info);
        close_escrow(ledger, lock, escrow, target, token_program)?;
    }
    Ok(())
}
