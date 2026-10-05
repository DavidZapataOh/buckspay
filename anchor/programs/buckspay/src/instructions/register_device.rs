use anchor_lang::prelude::*;

use crate::{
    device_envelope, error::BuckspayError, state::DEVICE_SEED,
    verification::require_one_verification, Device,
};

#[derive(Accounts)]
#[instruction(key: [u8; 33])]
pub struct RegisterDevice<'info> {
    /// The wallet the key is bound to: its signature is the consent, checked against the binding.
    pub wallet: Signer<'info>,
    /// Pays the device account's rent: the wallet itself, or a sponsor.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = Device::DISCRIMINATOR.len() + Device::INIT_SPACE,
        seeds = [DEVICE_SEED, &key[..1], &key[1..]],
        bump,
    )]
    pub device: Account<'info, Device>,
    /// CHECK: the instructions sysvar, pinned by address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> RegisterDevice<'info> {
    pub fn process(&mut self, bumps: &RegisterDeviceBumps, key: [u8; 33]) -> Result<()> {
        let wallet = self.wallet.key();
        let expected = device_envelope(&wallet, &key)?;
        require_one_verification(
            &self.instructions.to_account_info(),
            &key,
            &expected,
            error!(BuckspayError::DeviceBinding),
        )?;
        self.device.set_inner(Device {
            wallet,
            bump: bumps.device,
            next_lock_seq: 0,
            rotations: 0,
        });
        Ok(())
    }
}
