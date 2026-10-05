use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    burn, close_account, transfer_checked, Burn, CloseAccount, Mint, TokenAccount, TokenInterface,
    TransferChecked,
};

use crate::accounting::{assert_solvent, Debit};
use crate::error::BuckspayError;
use crate::state::{Ledger, LEDGER_SEED};

/// Moves the amount of `debit` from `escrow` to `destination`, signed by `ledger`, then reloads
/// `escrow` and checks solvency. The only code that moves funds out of an escrow.
///
/// A zero debit is rejected with `AmountZero`.
///
/// The `Debit` is taken by value and nothing else carries an amount, so the instruction cannot
/// pay a number the ledger did not give up:
///
/// ```
/// use anchor_lang::prelude::*;
/// use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
/// use buckspay::{accounting::Debit, payout::pay_out, state::Ledger};
///
/// let _: for<'a> fn(
///     &Account<'a, Ledger>,
///     &Pubkey,
///     &mut InterfaceAccount<'a, TokenAccount>,
///     &InterfaceAccount<'a, Mint>,
///     &InterfaceAccount<'a, TokenAccount>,
///     &Interface<'a, TokenInterface>,
///     Debit,
/// ) -> Result<()> = pay_out;
/// ```
///
/// ```compile_fail,E0308
/// use anchor_lang::prelude::*;
/// use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
/// use buckspay::{payout::pay_out, state::Ledger};
///
/// let _: for<'a> fn(
///     &Account<'a, Ledger>,
///     &Pubkey,
///     &mut InterfaceAccount<'a, TokenAccount>,
///     &InterfaceAccount<'a, Mint>,
///     &InterfaceAccount<'a, TokenAccount>,
///     &Interface<'a, TokenInterface>,
///     u64,
/// ) -> Result<()> = pay_out;
/// ```
pub fn pay_out<'info>(
    ledger: &Account<'info, Ledger>,
    lock: &Pubkey,
    escrow: &mut InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    destination: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
    debit: Debit,
) -> Result<()> {
    let amount = debit.into_amount();
    require!(amount > 0, BuckspayError::AmountZero);
    let seeds: &[&[u8]] = &[LEDGER_SEED, lock.as_ref(), &[ledger.bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: escrow.to_account_info(),
                mint: mint.to_account_info(),
                to: destination.to_account_info(),
                authority: ledger.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )?;
    escrow.reload()?;
    assert_solvent(ledger, escrow.amount)
}

/// Closes an empty escrow of a withdrawn lock and returns its rent to `rent_receiver`. The token
/// program refuses a balance above zero.
pub fn close_escrow<'info>(
    ledger: &Account<'info, Ledger>,
    lock: &Pubkey,
    escrow: &InterfaceAccount<'info, TokenAccount>,
    rent_receiver: &AccountInfo<'info>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    require!(ledger.withdrawn, BuckspayError::NotWithdrawn);
    let seeds: &[&[u8]] = &[LEDGER_SEED, lock.as_ref(), &[ledger.bump]];
    close_account(CpiContext::new_with_signer(
        token_program.key(),
        CloseAccount {
            account: escrow.to_account_info(),
            destination: rent_receiver.clone(),
            authority: ledger.to_account_info(),
        },
        &[seeds],
    ))
}

/// Moves `amount` from `from` to `to`, signed by `authority`: the funding of an escrow by its
/// wallet, and the sponsor's fee. The only transfer into an escrow.
pub fn pay_in<'info>(
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    authority: &Signer<'info>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: authority.to_account_info(),
            },
        ),
        amount,
        mint.decimals,
    )
}

/// Destroys the amount of `debit` out of `escrow`, signed by `ledger`, then reloads `escrow` and
/// checks solvency. The only code that burns.
pub fn burn_out<'info>(
    ledger: &Account<'info, Ledger>,
    lock: &Pubkey,
    escrow: &mut InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    token_program: &Interface<'info, TokenInterface>,
    debit: Debit,
) -> Result<()> {
    let amount = debit.into_amount();
    require!(amount > 0, BuckspayError::AmountZero);
    let seeds: &[&[u8]] = &[LEDGER_SEED, lock.as_ref(), &[ledger.bump]];
    burn(
        CpiContext::new_with_signer(
            token_program.key(),
            Burn {
                mint: mint.to_account_info(),
                from: escrow.to_account_info(),
                authority: ledger.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    escrow.reload()?;
    assert_solvent(ledger, escrow.amount)
}
