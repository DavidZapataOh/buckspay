use anchor_lang::{
    prelude::*,
    system_program::{self, Transfer},
};

use crate::{
    error::BuckspayError,
    state::{Device, DEVICE_SEED},
};

/// The length of a `Device` before the counters were added.
const LEGACY_DEVICE_LEN: usize = 41;

#[derive(Accounts)]
#[instruction(key: [u8; 33])]
pub struct MigrateDevice<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: owner, discriminator, length and bump are checked in the handler before any write.
    #[account(mut, seeds = [DEVICE_SEED, &key[..1], &key[1..]], bump)]
    pub device: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl MigrateDevice<'_> {
    /// Grows a `Device` created before the counters existed to the current layout, keeping its
    /// first 41 bytes and starting the counters at zero. Permissionless: the payer funds only the
    /// difference in rent.
    pub fn process(&mut self, bumps: &MigrateDeviceBumps) -> Result<()> {
        let device = self.device.to_account_info();
        {
            let data = device.try_borrow_data()?;
            require!(
                device.owner == &crate::ID
                    && data.len() == LEGACY_DEVICE_LEN
                    && data[..Device::DISCRIMINATOR.len()] == *Device::DISCRIMINATOR
                    && data[LEGACY_DEVICE_LEN - 1] == bumps.device,
                BuckspayError::NotMigratable
            );
        }
        let target = Device::DISCRIMINATOR.len() + Device::INIT_SPACE;
        let missing = Rent::get()?
            .minimum_balance(target)
            .saturating_sub(device.lamports());
        if missing > 0 {
            system_program::transfer(
                CpiContext::new(
                    self.system_program.key(),
                    Transfer {
                        from: self.payer.to_account_info(),
                        to: device.clone(),
                    },
                ),
                missing,
            )?;
        }
        device.resize(target)?;
        Ok(())
    }
}
