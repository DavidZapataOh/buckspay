use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use buckspay_protocol::{
    payword::{self, canonical_exps, Commitment, MAX_DEPTH},
    secp256r1::Expected,
    window::{self, Settle},
};

use crate::{
    accounting::assert_solvent,
    channel::{self, Channel, CHANNEL_SEED, MAX_CHANNELS_PER_TX},
    clock::now,
    error::BuckspayError,
    payout::pay_out,
    pda::create_pda,
    rewards::{tree, LeafAppended, RewardMint, RewardTree, REWARD_MINT_SEED, REWARD_TREE_SEED},
    state::{Ledger, Lock, ESCROW_SEED, LEDGER_SEED, LOCK_SEED},
    verification::require_chain,
};

/// One word of a channel with the siblings of its path to the root.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct WireWord {
    pub index: u16,
    pub word: [u8; 32],
    pub path: Vec<[u8; 32]>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ChannelWords {
    pub issuer_key: [u8; 33],
    pub lock_seq: u32,
    /// Present on the first settlement of a channel: its signature is checked once, by the
    /// secp256r1 instruction of the transaction. Later batches verify against `Channel.root`.
    pub commitment: Option<[u8; payword::COMMITMENT_LEN]>,
    pub words: Vec<WireWord>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct SettleChannelArgs {
    pub channels: Vec<ChannelWords>,
    /// `Poseidon(nullifier, trapdoor)` of the relayer, one per exponent of
    /// `canonical_exps(total words)`, in that order. The program computes the leaves itself.
    pub inners: Vec<[u8; 32]>,
}

/// The accounts per channel, in `remaining_accounts`: lock, ledger, escrow, channel.
const PER_CHANNEL: usize = 4;

#[derive(Accounts)]
pub struct SettleChannel<'info> {
    /// Pays the rent of the channels it creates.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
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
    #[account(
        mut,
        seeds = [REWARD_TREE_SEED, mint.key().as_ref(), &reward_mint.epoch.to_le_bytes()],
        bump = tree.load()?.bump,
    )]
    pub tree: AccountLoader<'info, RewardTree>,
    #[account(address = reward_mint.mint, mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the instructions sysvar, pinned by address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// A channel as a batch of words sees it, whether it was just created or read back.
struct View {
    root: [u8; 32],
    depth: u8,
    word_value: u64,
    cum_end: u64,
    expiry: u32,
}

impl<'info> SettleChannel<'info> {
    pub fn process(
        &mut self,
        args: SettleChannelArgs,
        accounts: &'info [AccountInfo<'info>],
    ) -> Result<()> {
        let SettleChannelArgs { channels, inners } = args;
        require!(
            (1..=MAX_CHANNELS_PER_TX).contains(&channels.len()),
            BuckspayError::TooManyChannels
        );
        require_eq!(
            accounts.len(),
            PER_CHANNEL * channels.len(),
            BuckspayError::RecordAccounts
        );

        let mut words = 0u32;
        for channel in &channels {
            let n = u32::try_from(channel.words.len())
                .map_err(|_| error!(BuckspayError::InnersDoNotMatchWords))?;
            require!(
                (1..=1u32 << MAX_DEPTH).contains(&n),
                BuckspayError::WordRejected
            );
            words = words
                .checked_add(n)
                .ok_or_else(|| error!(BuckspayError::AmountOverflow))?;
        }
        let exps = canonical_exps(words).ok_or(BuckspayError::InnersDoNotMatchWords)?;
        require_eq!(
            inners.len(),
            exps.len(),
            BuckspayError::InnersDoNotMatchWords
        );
        let leaves = inners
            .iter()
            .zip(&exps)
            .map(|(inner, exp)| tree::leaf(inner, *exp))
            .collect::<Result<Vec<_>>>()?;

        let commitments = channels
            .iter()
            .map(|c| {
                c.commitment
                    .map(|bytes| Commitment::decode(&bytes))
                    .transpose()
                    .map_err(|_| error!(BuckspayError::CommitmentInvalid))
            })
            .collect::<Result<Vec<_>>>()?;
        let domain = crate::payword_domain();
        let mut signed: Vec<Expected> = Vec::new();
        for (c, commitment) in channels.iter().zip(&commitments) {
            if let Some(commitment) = commitment {
                let envelope = payword::payword_signing(&domain, commitment)
                    .map_err(|_| error!(BuckspayError::CommitmentInvalid))?;
                signed.push((c.issuer_key, envelope));
            }
        }
        require_chain(
            &self.instructions,
            &signed,
            0,
            error!(BuckspayError::ChainVerification),
        )?;

        let now = now()?;
        let mut pool = 0u64;
        for (i, (c, commitment)) in channels.iter().zip(&commitments).enumerate() {
            let [lock, ledger, escrow, channel] = &accounts[i * PER_CHANNEL..][..PER_CHANNEL]
            else {
                return Err(error!(BuckspayError::RecordAccounts));
            };
            pool = pool
                .checked_add(self.settle_one(
                    now,
                    c,
                    commitment.as_ref(),
                    lock,
                    ledger,
                    escrow,
                    channel,
                )?)
                .ok_or_else(|| error!(BuckspayError::AmountOverflow))?;
        }

        self.pool_ledger.credit_reward(pool)?;
        self.pool_escrow.reload()?;
        assert_solvent(&self.pool_ledger, self.pool_escrow.amount)?;

        let mut tree = self.tree.load_mut()?;
        let first = tree::append_batch(&mut tree, &leaves)?;
        let epoch = tree.epoch;
        drop(tree);
        for (k, (leaf, exp)) in leaves.iter().zip(&exps).enumerate() {
            emit!(LeafAppended {
                epoch,
                index: first + k as u32,
                leaf: *leaf,
                exp: *exp,
            });
        }
        Ok(())
    }

    /// Verifies and settles the words of one channel, draws their value from its lock and pays the
    /// fee and the pool share. Returns what the pool is owed.
    #[allow(clippy::too_many_arguments)]
    fn settle_one(
        &self,
        now: u32,
        c: &ChannelWords,
        commitment: Option<&Commitment>,
        lock_info: &'info AccountInfo<'info>,
        ledger_info: &'info AccountInfo<'info>,
        escrow_info: &'info AccountInfo<'info>,
        channel_info: &'info AccountInfo<'info>,
    ) -> Result<u64> {
        let lock = Account::<Lock>::try_from(lock_info)?;
        require_keys_eq!(lock.mint, self.mint.key(), BuckspayError::WrongLock);
        let lock_key = lock_info.key();
        require_keys_eq!(
            lock_key,
            Pubkey::create_program_address(
                &[
                    LOCK_SEED,
                    &c.issuer_key[..1],
                    &c.issuer_key[1..],
                    &c.lock_seq.to_le_bytes(),
                    &[lock.bump]
                ],
                &crate::ID
            )
            .map_err(|_| error!(BuckspayError::WrongLock))?,
            BuckspayError::WrongLock
        );
        let mut ledger = Account::<Ledger>::try_from(ledger_info)?;
        require_keys_eq!(
            ledger_info.key(),
            Pubkey::create_program_address(
                &[LEDGER_SEED, lock_key.as_ref(), &[ledger.bump]],
                &crate::ID
            )
            .map_err(|_| error!(BuckspayError::WrongLock))?,
            BuckspayError::WrongLock
        );
        let mut escrow = InterfaceAccount::<TokenAccount>::try_from(escrow_info)?;
        require_keys_eq!(
            escrow_info.key(),
            Pubkey::create_program_address(
                &[ESCROW_SEED, lock_key.as_ref(), &[lock.escrow_bump]],
                &crate::ID
            )
            .map_err(|_| error!(BuckspayError::WrongLock))?,
            BuckspayError::WrongLock
        );

        let (view, mut channel) = match commitment {
            Some(commitment) => {
                require!(
                    commitment.mint == lock.mint.to_bytes() && commitment.lock_seq == c.lock_seq,
                    BuckspayError::WrongLock
                );
                let hash = commitment.hash();
                let (address, bump) = Pubkey::find_program_address(
                    &[CHANNEL_SEED, lock_key.as_ref(), &hash],
                    &crate::ID,
                );
                require_keys_eq!(channel_info.key(), address, BuckspayError::RecordAccounts);
                require!(
                    *channel_info.owner == anchor_lang::system_program::ID
                        && channel_info.data_is_empty(),
                    BuckspayError::RecordAccounts
                );
                let view = View {
                    root: commitment.root,
                    depth: commitment.depth,
                    word_value: commitment.word_value,
                    cum_end: commitment.cum_end,
                    expiry: commitment.expiry,
                };
                self.check_view(&view, &lock, now)?;
                create_pda(
                    channel_info,
                    &[CHANNEL_SEED, lock_key.as_ref(), &hash, &[bump]],
                    Channel::DISCRIMINATOR.len() + Channel::INIT_SPACE,
                    &self.payer,
                    &self.system_program,
                )?;
                let channel = Channel {
                    lock: lock_key,
                    commitment_hash: hash,
                    root: view.root,
                    depth: view.depth,
                    word_value: view.word_value,
                    cum_end: view.cum_end,
                    expiry: view.expiry,
                    settled: [0; channel::BITMAP_LEN],
                    payer: self.payer.key(),
                    closable_at: channel::closable_at(view.expiry, lock.lock_until)?,
                    bump,
                };
                (view, channel)
            }
            None => {
                let channel = Account::<Channel>::try_from(channel_info)?;
                require_keys_eq!(channel.lock, lock_key, BuckspayError::WrongLock);
                require_keys_eq!(
                    channel_info.key(),
                    Pubkey::create_program_address(
                        &[
                            CHANNEL_SEED,
                            lock_key.as_ref(),
                            &channel.commitment_hash,
                            &[channel.bump]
                        ],
                        &crate::ID
                    )
                    .map_err(|_| error!(BuckspayError::RecordAccounts))?,
                    BuckspayError::RecordAccounts
                );
                let view = View {
                    root: channel.root,
                    depth: channel.depth,
                    word_value: channel.word_value,
                    cum_end: channel.cum_end,
                    expiry: channel.expiry,
                };
                self.check_view(&view, &lock, now)?;
                (view, channel.into_inner())
            }
        };

        for word in &c.words {
            require!(
                payword::verify_path(&view.root, view.depth, word.index, &word.word, &word.path),
                BuckspayError::WordRejected
            );
            channel.settle_word(word.index)?;
        }

        let n = c.words.len() as u64;
        let fee = n
            .checked_mul(self.reward_mint.word_fee)
            .ok_or_else(|| error!(BuckspayError::AmountOverflow))?;
        let share = n
            .checked_mul(self.reward_mint.unit)
            .ok_or_else(|| error!(BuckspayError::AmountOverflow))?;
        for (amount, destination) in [(fee, &self.fee_account), (share, &self.pool_escrow)] {
            let debit = ledger.pay_backing(amount)?;
            pay_out(
                &ledger,
                &lock_key,
                &mut escrow,
                &self.mint,
                destination,
                &self.token_program,
                debit,
            )?;
        }
        ledger.exit(&crate::ID)?;

        let mut data = channel_info.try_borrow_mut_data()?;
        channel.try_serialize(&mut &mut data[..])?;
        Ok(share)
    }

    /// The rules a channel meets on every batch: the words are the mint's, the lock covers them
    /// and the window is open.
    fn check_view(&self, view: &View, lock: &Lock, now: u32) -> Result<()> {
        require!(
            view.word_value == self.reward_mint.word_value,
            BuckspayError::WordValueMismatch
        );
        channel::check_commitment(
            view.depth,
            view.word_value,
            view.cum_end,
            lock.bond,
            lock.backing,
        )?;
        match window::settle(view.expiry, lock.lock_until, now) {
            Settle::Open => Ok(()),
            Settle::LockEnded | Settle::Closed => Err(error!(BuckspayError::ChannelWindowClosed)),
        }
    }
}
