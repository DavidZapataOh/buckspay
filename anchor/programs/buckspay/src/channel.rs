//! Delivery-word channels: the account that records which words of a signed commitment were
//! settled, and the rules every batch of words is held to.
use anchor_lang::prelude::*;
use buckspay_protocol::{
    payword::{MAX_DEPTH, MIN_DEPTH},
    GRACE,
};

use crate::error::BuckspayError;

pub const CHANNEL_SEED: &[u8] = b"channel";
/// How long after its last settleable second a channel stays before anyone may close it.
pub const CHANNEL_CLOSE_DELAY: u32 = 7 * 86_400;
pub const MAX_CHANNELS_PER_TX: usize = 4;
/// Words are settled one bit each, so a channel holds at most 256.
pub const BITMAP_LEN: usize = 1 << (MAX_DEPTH - 3);

#[account]
#[derive(InitSpace, Debug, PartialEq, Eq)]
pub struct Channel {
    pub lock: Pubkey,
    pub commitment_hash: [u8; 32],
    /// The root of the words, stored at creation: every later batch is verified against it.
    pub root: [u8; 32],
    pub depth: u8,
    pub word_value: u64,
    pub cum_end: u64,
    pub expiry: u32,
    pub settled: [u8; BITMAP_LEN],
    /// Gets the rent back when the channel is closed.
    pub payer: Pubkey,
    pub closable_at: u32,
    pub bump: u8,
}

impl Channel {
    pub fn is_settled(&self, index: u16) -> bool {
        self.settled[usize::from(index) / 8] >> (index % 8) & 1 == 1
    }

    /// Marks a word settled; a word already marked is refused, which also refuses a word listed
    /// twice in one batch.
    pub fn settle_word(&mut self, index: u16) -> Result<()> {
        require!(
            u32::from(index) < 1 << self.depth && !self.is_settled(index),
            BuckspayError::WordAlreadySettled
        );
        self.settled[usize::from(index) / 8] |= 1 << (index % 8);
        Ok(())
    }
}

/// The second from which a channel may be closed: its words are refused after `expiry + GRACE` and
/// after the lock ends, so the later of the two never matters.
pub fn closable_at(expiry: u32, lock_until: u32) -> Result<u32> {
    let last = (u64::from(expiry) + u64::from(GRACE)).min(u64::from(lock_until));
    u32::try_from(last + u64::from(CHANNEL_CLOSE_DELAY))
        .map_err(|_| error!(BuckspayError::ClockOutOfRange))
}

/// The commitment as a lock must accept it: the words are worth a quarter of the bond at most, and
/// the interval they spend lies inside the lock's backing.
pub fn check_commitment(
    depth: u8,
    word_value: u64,
    cum_end: u64,
    bond: u64,
    backing: u64,
) -> Result<()> {
    require!(
        (MIN_DEPTH..=MAX_DEPTH).contains(&depth),
        BuckspayError::CommitmentInvalid
    );
    let total = word_value
        .checked_mul(1 << depth)
        .ok_or_else(|| error!(BuckspayError::AmountOverflow))?;
    require!(total <= bond / 4, BuckspayError::ChannelAboveBondQuarter);
    require!(
        cum_end <= backing && cum_end >= total,
        BuckspayError::WrongLock
    );
    Ok(())
}
