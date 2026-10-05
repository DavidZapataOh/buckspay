use anchor_lang::prelude::*;

use crate::{
    refund::refund_target,
    state::{Device, Rotation, DEVICE_SEED, ROTATION_SEED},
};

/// The current wallet's veto: its one signature removes a pending rotation, whoever requested it.
#[derive(Accounts)]
#[instruction(key: [u8; 33])]
pub struct CancelWalletRotation<'info> {
    pub wallet: Signer<'info>,
    #[account(
        mut,
        seeds = [DEVICE_SEED, &key[..1], &key[1..]],
        bump = device.bump,
        has_one = wallet,
    )]
    pub device: Account<'info, Device>,
    #[account(
        mut,
        seeds = [ROTATION_SEED, &key[..1], &key[1..]],
        bump = rotation.bump,
    )]
    pub rotation: Account<'info, Rotation>,
    /// CHECK: pinned to the account that paid the rotation's rent.
    #[account(mut, address = rotation.payer)]
    pub rent_receiver: UncheckedAccount<'info>,
}

impl CancelWalletRotation<'_> {
    /// Closes the rotation to its payer, or to the device if the payer can no longer take lamports.
    pub fn process(&mut self) -> Result<()> {
        let device = self.device.to_account_info();
        let receiver = self.rent_receiver.to_account_info();
        self.rotation
            .close(refund_target(&receiver, &device).clone())
    }
}
