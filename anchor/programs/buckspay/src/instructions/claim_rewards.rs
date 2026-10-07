use anchor_lang::{prelude::*, system_program};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use buckspay_protocol::payword::{MAX_LEAF_EXP, MIN_LEAF_EXP};
use buckspay_zk_verify::{
    fr, verify_claims_with, ClaimPublic, VerifyError, CLAIM_NUM_PUBLIC, CLAIM_PROOF_COMPRESSED,
};

use crate::{
    clock::now,
    error::BuckspayError,
    payout::pay_out,
    pda::create_pda,
    rewards::{
        scope, tree, RewardConfig, RewardMint, RewardTree, CLAIM_WINDOW_SECS, MAX_CLAIMS_PER_TX,
        REWARD_CONFIG_SEED, REWARD_MINT_SEED, REWARD_NULLIFIER_SEED, REWARD_TREE_SEED,
    },
    state::{Ledger, ESCROW_SEED, LEDGER_SEED},
};

/// One claim: the tree and root it opens, its nullifier hash, the exponent of its leaf and its
/// proof. Everything else the proof binds is read from the accounts.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OneClaim {
    pub epoch: u32,
    pub root: [u8; 32],
    pub nullifier_hash: [u8; 32],
    pub exp: u8,
    pub proof: [u8; CLAIM_PROOF_COMPRESSED],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ClaimArgs {
    pub vk_sha256: [u8; 32],
    /// The fee ceiling every proof of the batch was made with.
    pub max_fee: u64,
    pub claims: Vec<OneClaim>,
}

/// The accounts per claim, in `remaining_accounts`: the tree of its epoch and its nullifier account.
const PER_CLAIM: usize = 2;

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    /// Pays the rent of the nullifier accounts.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [REWARD_CONFIG_SEED], bump = reward_config.bump)]
    pub reward_config: Box<Account<'info, RewardConfig>>,
    #[account(
        mut,
        seeds = [REWARD_MINT_SEED, mint.key().as_ref()],
        bump = reward_mint.bump,
    )]
    pub reward_mint: Box<Account<'info, RewardMint>>,
    #[account(mut, seeds = [LEDGER_SEED, reward_mint.key().as_ref()], bump = pool_ledger.bump)]
    pub pool_ledger: Box<Account<'info, Ledger>>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, reward_mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool_ledger,
        token::token_program = token_program,
    )]
    pub pool_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        address = reward_mint.fee_account,
        token::mint = mint,
        token::token_program = token_program,
    )]
    pub fee_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The proofs bind the owner of this account as the recipient.
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub recipient: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = reward_mint.mint, mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// What a batch of claims moves out of the pool.
#[derive(Debug, PartialEq, Eq)]
pub struct Amounts {
    /// `sum(unit * 2^exp)`: the leaves' worth.
    pub gross: u64,
    /// What the recipient gets: `gross - fees`.
    pub net: u64,
    /// `claims * claim_fee`: what the fee account gets.
    pub fees: u64,
}

pub fn amounts(
    unit: u64,
    claim_fee: u64,
    exps: impl ExactSizeIterator<Item = u8>,
) -> Result<Amounts> {
    let claims = exps.len() as u64;
    let mut gross = 0u64;
    for exp in exps {
        let value = 1u64
            .checked_shl(u32::from(exp))
            .and_then(|scale| unit.checked_mul(scale))
            .ok_or_else(|| error!(BuckspayError::AmountOverflow))?;
        gross = gross
            .checked_add(value)
            .ok_or_else(|| error!(BuckspayError::AmountOverflow))?;
    }
    let fees = claim_fee
        .checked_mul(claims)
        .ok_or_else(|| error!(BuckspayError::AmountOverflow))?;
    let net = gross
        .checked_sub(fees)
        .ok_or_else(|| error!(BuckspayError::FeeAboveValue))?;
    Ok(Amounts { gross, net, fees })
}

fn word(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(bytes);
    out
}

fn verify_error(error: VerifyError) -> Error {
    match error {
        VerifyError::NonCanonical => error!(BuckspayError::NonCanonicalPublic),
        _ => error!(BuckspayError::ClaimRejected),
    }
}

impl<'info> ClaimRewards<'info> {
    pub fn process(
        &mut self,
        args: ClaimArgs,
        remaining: &'info [AccountInfo<'info>],
    ) -> Result<()> {
        require!(!self.reward_config.paused, BuckspayError::RewardsPaused);
        let now = now()?;
        let key = self.reward_config.claim_vk(&args.vk_sha256, now)?;
        let ClaimArgs {
            max_fee, claims, ..
        } = args;
        require!(
            (1..=MAX_CLAIMS_PER_TX).contains(&claims.len())
                && remaining.len() == claims.len() * PER_CLAIM,
            BuckspayError::ClaimCount
        );
        let claim_fee = self.reward_mint.claim_fee;
        require!(claim_fee <= max_fee, BuckspayError::FeeAboveMax);

        let mint = self.mint.key();
        let owner = self.recipient.owner.to_bytes();
        let (recipient_hi, recipient_lo) = (word(&owner[..16]), word(&owner[16..]));
        let (scope, max_fee_word) = (scope(&mint), word(&max_fee.to_be_bytes()));

        let mut proofs = Vec::with_capacity(claims.len());
        let mut publics: Vec<ClaimPublic> = Vec::with_capacity(claims.len());
        let mut nullifiers = Vec::with_capacity(claims.len());
        for (i, (claim, accounts)) in claims.iter().zip(remaining.chunks(PER_CLAIM)).enumerate() {
            require!(
                claims[..i]
                    .iter()
                    .all(|earlier| earlier.nullifier_hash != claim.nullifier_hash),
                BuckspayError::NullifierReused
            );
            require!(
                (MIN_LEAF_EXP..=MAX_LEAF_EXP).contains(&claim.exp),
                BuckspayError::BadDenomination
            );
            require!(
                fr::is_canonical(&claim.nullifier_hash),
                BuckspayError::NonCanonicalNullifier
            );
            let [tree_info, nullifier_info] = accounts else {
                return err!(BuckspayError::ClaimCount);
            };
            Self::check_root(tree_info, &mint, claim)?;
            let (address, bump) = Pubkey::find_program_address(
                &[REWARD_NULLIFIER_SEED, mint.as_ref(), &claim.nullifier_hash],
                &crate::ID,
            );
            require_keys_eq!(
                nullifier_info.key(),
                address,
                BuckspayError::WrongNullifierAccount
            );
            require!(
                nullifier_info.owner == &system_program::ID && nullifier_info.data_is_empty(),
                BuckspayError::NullifierReused
            );
            nullifiers.push((nullifier_info, claim.nullifier_hash, bump));

            let mut public: ClaimPublic = [[0u8; 32]; CLAIM_NUM_PUBLIC];
            public[0] = claim.root;
            public[1] = claim.nullifier_hash;
            public[2] = scope;
            public[3] = recipient_hi;
            public[4] = recipient_lo;
            public[5] = word(&[claim.exp]);
            public[6] = max_fee_word;
            publics.push(public);
            proofs.push(claim.proof);
        }
        verify_claims_with(&key, &proofs, &publics).map_err(verify_error)?;

        let Amounts { gross, net, fees } = amounts(
            self.reward_mint.unit,
            claim_fee,
            claims.iter().map(|claim| claim.exp),
        )?;
        let (claim_cap, window) = (self.reward_mint.claim_cap, &mut self.reward_mint.window);
        window.admit_or(
            i64::from(now),
            gross,
            claim_cap,
            CLAIM_WINDOW_SECS,
            BuckspayError::ClaimCapExceeded,
        )?;

        for (info, hash, bump) in nullifiers {
            create_pda(
                info,
                &[REWARD_NULLIFIER_SEED, mint.as_ref(), &hash, &[bump]],
                0,
                &self.payer,
                &self.system_program,
            )?;
        }

        let pool = self.reward_mint.key();
        for (amount, to_recipient) in [(net, true), (fees, false)] {
            if amount == 0 {
                continue;
            }
            let debit = self.pool_ledger.pay_reward(amount)?;
            let destination = if to_recipient {
                &self.recipient
            } else {
                &self.fee_account
            };
            pay_out(
                &self.pool_ledger,
                &pool,
                &mut self.pool_escrow,
                &self.mint,
                destination,
                &self.token_program,
                debit,
            )?;
        }
        Ok(())
    }

    /// The tree of the claim's epoch at its own address, and a root it pushed.
    fn check_root(info: &'info AccountInfo<'info>, mint: &Pubkey, claim: &OneClaim) -> Result<()> {
        let loader = AccountLoader::<RewardTree>::try_from(info)
            .map_err(|_| error!(BuckspayError::WrongRewardTree))?;
        let tree_account = loader.load()?;
        require!(
            tree_account.mint == *mint && tree_account.epoch == claim.epoch,
            BuckspayError::WrongRewardTree
        );
        let address = Pubkey::create_program_address(
            &[
                REWARD_TREE_SEED,
                mint.as_ref(),
                &claim.epoch.to_le_bytes(),
                &[tree_account.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(BuckspayError::WrongRewardTree))?;
        require_keys_eq!(info.key(), address, BuckspayError::WrongRewardTree);
        require!(
            tree::known_root(&tree_account, &claim.root),
            BuckspayError::UnknownRoot
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn a_batch_moves_exactly_its_leaves_and_never_wraps(
            unit in any::<u64>(),
            claim_fee in any::<u64>(),
            exps in prop::collection::vec(MIN_LEAF_EXP..=MAX_LEAF_EXP, 1..=MAX_CLAIMS_PER_TX),
        ) {
            let wide: u128 = exps.iter().map(|e| u128::from(unit) << e).sum();
            let fees = u128::from(claim_fee) * exps.len() as u128;
            match amounts(unit, claim_fee, exps.iter().copied()) {
                Ok(a) => {
                    prop_assert_eq!(u128::from(a.gross), wide);
                    prop_assert_eq!(u128::from(a.fees), fees);
                    prop_assert_eq!(u128::from(a.net) + u128::from(a.fees), wide);
                }
                Err(_) => prop_assert!(wide > u128::from(u64::MAX) || fees > wide || fees > u128::from(u64::MAX)),
            }
        }

        #[test]
        fn a_fee_below_the_smallest_leaf_always_leaves_something_to_pay(
            unit in 2u64..=u64::MAX / 1024,
            fee_seed in any::<u64>(),
            exps in prop::collection::vec(MIN_LEAF_EXP..=MAX_LEAF_EXP, 1..=MAX_CLAIMS_PER_TX),
        ) {
            let claim_fee = fee_seed % unit;
            let a = amounts(unit, claim_fee, exps.iter().copied()).unwrap();
            prop_assert!(a.net > 0);
        }
    }
}
