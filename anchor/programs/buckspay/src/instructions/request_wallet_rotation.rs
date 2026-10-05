use anchor_lang::prelude::*;
use buckspay_protocol::lock::ROTATION_DELAY;

use crate::{
    clock::now,
    error::BuckspayError,
    rotation_envelope,
    state::{Device, Rotation, DEVICE_SEED, ROTATION_SEED},
    verification::require_one_verification,
};

#[derive(Accounts)]
#[instruction(key: [u8; 33])]
pub struct RequestWalletRotation<'info> {
    pub new_wallet: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [DEVICE_SEED, &key[..1], &key[1..]],
        bump = device.bump,
    )]
    pub device: Account<'info, Device>,
    #[account(
        init,
        payer = payer,
        space = Rotation::DISCRIMINATOR.len() + Rotation::INIT_SPACE,
        seeds = [ROTATION_SEED, &key[..1], &key[1..]],
        bump,
    )]
    pub rotation: Account<'info, Rotation>,
    /// CHECK: the instructions sysvar, pinned by address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> RequestWalletRotation<'info> {
    /// Needs the device key's signature over this rotation (kind, wallets, key and the device's
    /// rotation counter) and the new wallet's own. The change takes effect `ROTATION_DELAY` later,
    /// and only if the current wallet has not cancelled it.
    pub fn process(&mut self, bumps: &RequestWalletRotationBumps, key: [u8; 33]) -> Result<()> {
        let old_wallet = self.device.wallet;
        let new_wallet = self.new_wallet.key();
        require_keys_neq!(new_wallet, old_wallet, BuckspayError::SameWallet);

        let expected = rotation_envelope(&old_wallet, &new_wallet, &key, self.device.rotations)?;
        require_one_verification(
            &self.instructions.to_account_info(),
            &key,
            &expected,
            error!(BuckspayError::RotationBinding),
        )?;
        self.device.rotations = self
            .device
            .rotations
            .checked_add(1)
            .ok_or(BuckspayError::AmountOverflow)?;

        let effective_at = now()?
            .checked_add(ROTATION_DELAY)
            .ok_or(BuckspayError::ClockOutOfRange)?;
        self.rotation.set_inner(Rotation {
            wallet: new_wallet,
            payer: self.payer.key(),
            effective_at,
            bump: bumps.rotation,
        });
        Ok(())
    }
}
