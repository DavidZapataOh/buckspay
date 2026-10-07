use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use buckspay_protocol::payword::{MAX_LEAVES_PER_TX, MIN_LEAF_EXP};
use core::mem::size_of;

use crate::{
    error::BuckspayError,
    mint::validate_mint,
    rewards::{
        RewardConfig, RewardMint, RewardPolicy, RewardTree, REWARD_CONFIG_SEED,
        REWARD_LEDGER_MARKER, REWARD_MINT_SEED, REWARD_TREE_SEED, TREE_CAPACITY,
    },
    state::{Ledger, ESCROW_SEED, LEDGER_SEED},
};

#[derive(Accounts)]
pub struct InitRewardConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = RewardConfig::DISCRIMINATOR.len() + RewardConfig::INIT_SPACE,
        seeds = [REWARD_CONFIG_SEED],
        bump,
    )]
    pub reward_config: Account<'info, RewardConfig>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, crate::program::Buckspay>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()))]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

impl InitRewardConfig<'_> {
    pub fn process(
        &mut self,
        bumps: &InitRewardConfigBumps,
        admin: Pubkey,
        pauser: Pubkey,
    ) -> Result<()> {
        self.reward_config.set_inner(RewardConfig {
            admin,
            pauser,
            paused: false,
            bump: bumps.reward_config,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct RewardAdmin<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [REWARD_CONFIG_SEED], bump = reward_config.bump)]
    pub reward_config: Account<'info, RewardConfig>,
}

impl RewardAdmin<'_> {
    /// The pauser may only pause; the admin may do either.
    pub fn set_paused(&mut self, paused: bool) -> Result<()> {
        let admin = self.signer.key() == self.reward_config.admin;
        let pauser = paused && self.signer.key() == self.reward_config.pauser;
        require!(admin || pauser, BuckspayError::NotRewardAdmin);
        self.reward_config.paused = paused;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitRewardMint<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [REWARD_CONFIG_SEED], bump = reward_config.bump, has_one = admin @ BuckspayError::NotRewardAdmin)]
    pub reward_config: Account<'info, RewardConfig>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = admin,
        space = RewardMint::DISCRIMINATOR.len() + RewardMint::INIT_SPACE,
        seeds = [REWARD_MINT_SEED, mint.key().as_ref()],
        bump,
    )]
    pub reward_mint: Box<Account<'info, RewardMint>>,
    #[account(
        init,
        payer = admin,
        space = Ledger::DISCRIMINATOR.len() + Ledger::INIT_SPACE,
        seeds = [LEDGER_SEED, reward_mint.key().as_ref()],
        bump,
    )]
    pub pool_ledger: Box<Account<'info, Ledger>>,
    #[account(
        init,
        payer = admin,
        seeds = [ESCROW_SEED, reward_mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool_ledger,
        token::token_program = token_program,
    )]
    pub pool_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = admin,
        space = RewardTree::DISCRIMINATOR.len() + size_of::<RewardTree>(),
        seeds = [REWARD_TREE_SEED, mint.key().as_ref(), &0u32.to_le_bytes()],
        bump,
    )]
    pub tree: AccountLoader<'info, RewardTree>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl InitRewardMint<'_> {
    pub fn process(&mut self, bumps: &InitRewardMintBumps, policy: RewardPolicy) -> Result<()> {
        validate_mint(&self.mint.to_account_info())?;
        let RewardPolicy {
            word_value,
            word_fee,
            max_fee,
            claim_fee,
            fee_account,
            claim_cap,
        } = policy;
        require!(
            word_fee > 0 && word_fee < word_value,
            BuckspayError::FeeAboveValue
        );
        let unit = word_value - word_fee;
        let smallest_leaf = unit
            .checked_mul(1 << MIN_LEAF_EXP)
            .ok_or_else(|| error!(BuckspayError::AmountOverflow))?;
        require!(
            claim_fee <= max_fee && max_fee < smallest_leaf && claim_fee < unit,
            BuckspayError::FeeAboveValue
        );
        self.reward_mint.set_inner(RewardMint {
            mint: self.mint.key(),
            word_value,
            word_fee,
            unit,
            max_fee,
            claim_fee,
            fee_account,
            claim_cap,
            epoch: 0,
            bump: bumps.reward_mint,
        });
        let mut key = [0u8; 33];
        key[0] = REWARD_LEDGER_MARKER;
        key[1..].copy_from_slice(self.mint.key().as_ref());
        self.pool_ledger.set_inner(Ledger::new(
            0,
            0,
            self.admin.key(),
            key,
            0,
            bumps.pool_ledger,
        ));
        let mut tree = self.tree.load_init()?;
        tree.mint = self.mint.key();
        tree.bump = bumps.tree;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct SetRewardPolicy<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [REWARD_CONFIG_SEED], bump = reward_config.bump, has_one = admin @ BuckspayError::NotRewardAdmin)]
    pub reward_config: Account<'info, RewardConfig>,
    #[account(mut, seeds = [REWARD_MINT_SEED, reward_mint.mint.as_ref()], bump = reward_mint.bump)]
    pub reward_mint: Account<'info, RewardMint>,
}

impl SetRewardPolicy<'_> {
    /// Changes what only splits or routes what the pool pays: the claim fee, where fees go and the
    /// claim cap. What a word is worth is fixed when the mint is configured.
    pub fn process(&mut self, claim_fee: u64, fee_account: Pubkey, claim_cap: u64) -> Result<()> {
        let mint = &mut self.reward_mint;
        require!(
            claim_fee <= mint.max_fee && claim_fee < mint.unit,
            BuckspayError::FeeAboveValue
        );
        mint.claim_fee = claim_fee;
        mint.fee_account = fee_account;
        mint.claim_cap = claim_cap;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct RotateRewardTree<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [REWARD_MINT_SEED, reward_mint.mint.as_ref()], bump = reward_mint.bump)]
    pub reward_mint: Account<'info, RewardMint>,
    #[account(
        seeds = [REWARD_TREE_SEED, reward_mint.mint.as_ref(), &reward_mint.epoch.to_le_bytes()],
        bump = current.load()?.bump,
    )]
    pub current: AccountLoader<'info, RewardTree>,
    #[account(
        init,
        payer = payer,
        space = RewardTree::DISCRIMINATOR.len() + size_of::<RewardTree>(),
        seeds = [
            REWARD_TREE_SEED,
            reward_mint.mint.as_ref(),
            &reward_mint.epoch.saturating_add(1).to_le_bytes(),
        ],
        bump,
    )]
    pub next: AccountLoader<'info, RewardTree>,
    pub system_program: Program<'info, System>,
}

impl RotateRewardTree<'_> {
    /// Starts the next epoch once the current tree cannot take another full batch of leaves. Old
    /// trees take no more appends and their roots stay valid.
    pub fn process(&mut self, bumps: &RotateRewardTreeBumps) -> Result<()> {
        require!(
            self.current.load()?.next_index > TREE_CAPACITY - MAX_LEAVES_PER_TX as u32,
            BuckspayError::TreeNotFull
        );
        let epoch = self
            .reward_mint
            .epoch
            .checked_add(1)
            .ok_or_else(|| error!(BuckspayError::TreeFull))?;
        let mut tree = self.next.load_init()?;
        tree.mint = self.reward_mint.mint;
        tree.epoch = epoch;
        tree.bump = bumps.next;
        self.reward_mint.epoch = epoch;
        Ok(())
    }
}
