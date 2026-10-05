use anchor_lang::prelude::*;
pub use buckspay_protocol::record::SPENT_SEED;

/// Seed prefixes of the program's accounts. Every account type has its own prefix and no prefix
/// is a prefix of another, so accounts of two types can never share an address.
pub const DEVICE_SEED: &[u8] = b"device";
pub const ROTATION_SEED: &[u8] = b"rotation";
pub const LOCK_SEED: &[u8] = b"lock";
pub const LEDGER_SEED: &[u8] = b"ledger";
pub const ESCROW_SEED: &[u8] = b"escrow";

/// A device key bound to a wallet, with the counters of its locks and wallet rotations. The key is
/// in the account's seeds, so it is not stored. `wallet` and `bump` keep the offsets they have always
/// had; the counters come after them.
#[account]
#[derive(InitSpace)]
pub struct Device {
    pub wallet: Pubkey,
    pub bump: u8,
    /// The sequence number the next lock must use: strictly increasing across mints, never reaches
    /// `NO_LOCK` as a lock's number.
    pub next_lock_seq: u32,
    /// Replay counter of wallet rotations.
    pub rotations: u32,
}

/// The immutable record of a bond lock. It is written once by `create_lock` and read by everything
/// else; it states exactly the fields of a bond ticket.
#[account]
#[derive(InitSpace)]
pub struct Lock {
    pub mint: Pubkey,
    pub bond: u64,
    pub backing: u64,
    pub lock_until: u32,
    pub bump: u8,
    /// The canonical bump of the lock's escrow, so settlements derive it without searching: the
    /// issuer's key chooses the lock's address and with it the cost of that search.
    pub escrow_bump: u8,
}

/// The mutable accounting of a lock and the authority of its escrow token account. The three
/// buckets only move forward; see `accounting`.
#[account]
#[derive(InitSpace, Debug, PartialEq, Eq)]
pub struct Ledger {
    /// Backing not yet paid out.
    pub backing_left: u64,
    /// Bond not committed to a slash.
    pub bond_free: u64,
    /// The pool: bond committed to claims, burn and reporter.
    pub bond_slashed: u64,
    /// Gets every rent back.
    pub payer: Pubkey,
    /// The device key, so the locks of one key can be listed with an account filter.
    pub key: [u8; 33],
    pub lock_seq: u32,
    pub withdrawn: bool,
    pub bump: u8,
}

/// A pending change of a device's wallet.
#[account]
#[derive(InitSpace)]
pub struct Rotation {
    pub wallet: Pubkey,
    pub payer: Pubkey,
    pub effective_at: u32,
    pub bump: u8,
}

/// The record of one output that a message consumed: which content won, who paid its rent and until
/// when it must be kept. The key is in the account's seeds and the bump is the fixed
/// `record::RECORD_BUMP`, so neither is stored.
#[account]
#[derive(InitSpace)]
pub struct Spent {
    /// The content of the message that consumed the output; for a reclaim, `record_content()`.
    pub content: [u8; 32],
    /// Gets the rent back.
    pub payer: Pubkey,
    /// Expiry of the consumed output.
    pub expiry: u32,
    /// `window::closable_at(expiry, lock_until)`: after every window in which the output can still
    /// be settled, reclaimed, reported or claimed against.
    pub closable_at: u32,
    /// `records::PAID` and `records::RECLAIMED`.
    pub flags: u8,
}
