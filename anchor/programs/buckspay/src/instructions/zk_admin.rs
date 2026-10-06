use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use buckspay_zk_verify::vk;

use crate::{
    clock::now,
    error::BuckspayError,
    pda::create_pda,
    zk::{self, KeyHashes, ZkConfig, ZkMint, ZK_CONFIG_SEED, ZK_MINT_SEED},
};

#[derive(Accounts)]
pub struct InitZkConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + ZkConfig::INIT_SPACE,
        seeds = [ZK_CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, ZkConfig>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, crate::program::Buckspay>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()))]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

impl InitZkConfig<'_> {
    pub fn process(
        &mut self,
        bumps: &InitZkConfigBumps,
        admin: Pubkey,
        pauser: Pubkey,
        current: KeyHashes,
    ) -> Result<()> {
        require!(
            zk::keys_permitted(vk::TEST_KEYS, &crate::GENESIS_HASH),
            BuckspayError::TestKeysOnMainnet
        );
        require!(
            current.vk == *vk::VK.sha256,
            BuckspayError::StaleVerifyingKey
        );
        self.config.set_inner(ZkConfig {
            admin,
            pauser,
            paused: false,
            current,
            previous: KeyHashes::default(),
            rotated_at: 0,
            bump: bumps.config,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ZkAdmin<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [ZK_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ZkConfig>,
}

impl ZkAdmin<'_> {
    fn require_admin(&self) -> Result<()> {
        require_keys_eq!(
            self.signer.key(),
            self.config.admin,
            BuckspayError::NotZkAdmin
        );
        Ok(())
    }

    fn is_pauser(&self) -> bool {
        self.signer.key() == self.config.pauser
    }

    /// The pauser may only pause; the admin may do either.
    pub fn set_paused(&mut self, paused: bool) -> Result<()> {
        if !(paused && self.is_pauser()) {
            self.require_admin()?;
        }
        self.config.paused = paused;
        Ok(())
    }

    /// Replaces the current key hashes by `next`, which must be the key this program carries. With
    /// `keep_previous` the replaced key stays accepted for the life of a note and its grace.
    pub fn rotate_vk(&mut self, next: KeyHashes, keep_previous: bool) -> Result<()> {
        self.require_admin()?;
        require!(next.vk == *vk::VK.sha256, BuckspayError::StaleVerifyingKey);
        if keep_previous {
            let carried = vk::PREVIOUS.is_some_and(|key| *key.sha256 == self.config.current.vk);
            require!(carried, BuckspayError::StaleVerifyingKey);
            self.config.previous = self.config.current;
            self.config.rotated_at = i64::from(now()?);
        } else {
            self.config.previous = KeyHashes::default();
            self.config.rotated_at = 0;
        }
        self.config.current = next;
        Ok(())
    }

    /// Ends the acceptance of the previous key at once. It only reduces what is accepted, so the
    /// pauser may call it too.
    pub fn revoke_previous_vk(&mut self) -> Result<()> {
        if !self.is_pauser() {
            self.require_admin()?;
        }
        self.config.previous = KeyHashes::default();
        self.config.rotated_at = 0;
        Ok(())
    }

    pub fn set_authorities(&mut self, admin: Pubkey, pauser: Pubkey) -> Result<()> {
        self.require_admin()?;
        self.config.admin = admin;
        self.config.pauser = pauser;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct SetZkMint<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [ZK_CONFIG_SEED], bump = config.bump, has_one = admin @ BuckspayError::NotZkAdmin)]
    pub config: Account<'info, ZkConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: the per-mint account at its derived address, created here on first use.
    #[account(mut)]
    pub zk_mint: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> SetZkMint<'info> {
    pub fn process(
        &mut self,
        global_cap: u64,
        lock_cap: u64,
        record_fee: u64,
        fee_account: Pubkey,
    ) -> Result<()> {
        require!(
            u128::from(lock_cap) * 10 <= u128::from(global_cap),
            BuckspayError::LockCapTooHigh
        );
        let info = self.zk_mint.to_account_info();
        let mint = self.mint.key();
        let mut value = if info.owner == &crate::ID {
            zk::read_mint(&info, &mint)?
        } else {
            let (address, bump) =
                Pubkey::find_program_address(&[ZK_MINT_SEED, mint.as_ref()], &crate::ID);
            require_keys_eq!(info.key(), address, BuckspayError::RecordAccounts);
            require!(info.data_is_empty(), BuckspayError::RecordAccounts);
            create_pda(
                &info,
                &[ZK_MINT_SEED, mint.as_ref(), &[bump]],
                8 + ZkMint::INIT_SPACE,
                &self.admin,
                &self.system_program,
            )?;
            ZkMint {
                global_cap,
                lock_cap,
                record_fee,
                fee_account,
                window: zk::Window::default(),
                bump,
            }
        };
        value.global_cap = global_cap;
        value.lock_cap = lock_cap;
        value.record_fee = record_fee;
        value.fee_account = fee_account;
        zk::write(&info, &value)
    }
}
