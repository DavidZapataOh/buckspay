use anchor_lang::prelude::*;

use crate::{
    clock::now,
    error::BuckspayError,
    refund::refund_target,
    state::{Device, Rotation, DEVICE_SEED, ROTATION_SEED},
};

#[derive(Accounts)]
#[instruction(key: [u8; 33])]
pub struct ApplyWalletRotation<'info> {
    #[account(
        mut,
        seeds = [DEVICE_SEED, &key[..1], &key[1..]],
        bump = device.bump,
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

impl ApplyWalletRotation<'_> {
    /// Nobody signs: the rotation was authorised when it was requested and the wallet had its
    /// chance to cancel it. The rotation closes to its payer, or to the device if the payer can no
    /// longer take lamports.
    pub fn process(&mut self) -> Result<()> {
        require!(
            now()? >= self.rotation.effective_at,
            BuckspayError::RotationNotReady
        );
        self.device.wallet = self.rotation.wallet;

        let device = self.device.to_account_info();
        let receiver = self.rent_receiver.to_account_info();
        self.rotation
            .close(refund_target(&receiver, &device).clone())
    }
}
