//! What the two claim instructions have in common: writing the claim of an output once, and
//! burning what it proves out of the lock's free bond.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use buckspay_protocol::record::RECORD_BUMP;

use crate::{
    burn::burn_for,
    error::BuckspayError,
    payout::burn_out,
    pda::create_pda,
    state::{Claim, Ledger, CLAIM_SEED},
};

/// The claim address of `output`: one `create_program_address` with the fixed bump, whatever the
/// output id. An output whose address is on the curve cannot be claimed (`UnrecordableOutput`);
/// receivers refuse such an output, so no loss is ever outside this check.
fn address(output: &[u8; 32]) -> Result<Pubkey> {
    Pubkey::create_program_address(&[CLAIM_SEED, output, &[RECORD_BUMP]], &crate::ID)
        .map_err(|_| error!(BuckspayError::UnrecordableOutput))
}

/// A loss of `loss` in `output`, claimed from `lock`.
pub(crate) struct Filing<'a, 'info> {
    pub lock_address: &'a Pubkey,
    pub ledger: &'a mut Account<'info, Ledger>,
    pub escrow: &'a mut InterfaceAccount<'info, TokenAccount>,
    pub mint: &'a InterfaceAccount<'info, Mint>,
    pub token_program: &'a Interface<'info, TokenInterface>,
    pub claim: &'a AccountInfo<'info>,
    pub payer: &'a Signer<'info>,
    pub system_program: &'a Program<'info, System>,
}

/// Writes the claim of `output` and burns `slash::penalty(loss, free bond)` out of the escrow. The
/// claim record stays until `closable_at`, so the same loss cannot be burned twice.
pub(crate) fn file(
    f: Filing<'_, '_>,
    output: &[u8; 32],
    loss: u64,
    closable_at: u32,
) -> Result<()> {
    require_keys_eq!(
        f.claim.key(),
        address(output)?,
        BuckspayError::RecordAccounts
    );
    require!(
        *f.claim.owner == anchor_lang::system_program::ID && f.claim.data_is_empty(),
        BuckspayError::AlreadyClaimed
    );
    let debit = burn_for(f.ledger, loss)?;

    create_pda(
        f.claim,
        &[CLAIM_SEED, output, &[RECORD_BUMP]],
        Claim::DISCRIMINATOR.len() + Claim::INIT_SPACE,
        f.payer,
        f.system_program,
    )?;
    let claim = Claim {
        lock: *f.lock_address,
        amount: loss,
        burned: debit.amount(),
        payer: f.payer.key(),
        closable_at,
    };
    claim.try_serialize(&mut &mut f.claim.try_borrow_mut_data()?[..])?;

    burn_out(
        f.ledger,
        f.lock_address,
        f.escrow,
        f.mint,
        f.token_program,
        debit,
    )
}

/// Burns the whole free stake of an attester out of its escrow and returns what was burned. Nothing
/// is paid to anybody: a false ticket costs its attester all it staked, as a deterrent and not as
/// insurance for the receivers that relied on it.
pub(crate) fn burn_stake<'info>(
    ledger: &mut Account<'info, Ledger>,
    attester: &Pubkey,
    escrow: &mut InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<u64> {
    let free = ledger.bond_free;
    require!(free > 0, BuckspayError::NoBond);
    // The penalty of a loss as large as the stake is the stake: `min(2 * free, free)`.
    let debit = burn_for(ledger, free)?;
    let burned = debit.amount();
    burn_out(ledger, attester, escrow, mint, token_program, debit)?;
    Ok(burned)
}
