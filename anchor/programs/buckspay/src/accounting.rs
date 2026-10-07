use anchor_lang::prelude::*;

use crate::error::BuckspayError;
use crate::{
    rewards::REWARD_LEDGER_MARKER,
    state::{Ledger, ATTESTER_LEDGER_MARKER},
};

/// The ledger's authorisation of one payout out of an escrow.
///
/// Only the [`Ledger`] methods that take money out of a bucket create a `Debit`, and only
/// [`crate::payout::pay_out`] consumes it, so the amount that leaves the escrow is the amount the
/// ledger gave up. It is neither `Clone` nor `Copy` and cannot be built outside this module.
///
/// ```compile_fail,E0451
/// use buckspay::accounting::Debit;
/// let forged = Debit { amount: 5 };
/// ```
///
/// ```compile_fail,E0624
/// use buckspay::accounting::Debit;
/// let forged = Debit::new(5);
/// ```
///
/// ```compile_fail,E0599
/// use buckspay::accounting::Debit;
/// let forged = Debit::default();
/// ```
///
/// ```compile_fail,E0308
/// use buckspay::accounting::Debit;
/// let forged = Debit::from(5u64);
/// ```
///
/// ```compile_fail,E0599
/// use anchor_lang::prelude::Pubkey;
/// use buckspay::state::Ledger;
/// let mut ledger = Ledger::new(10, 10, Pubkey::default(), [2; 33], 0, 255);
/// let debit = ledger.pay_backing(5).unwrap();
/// let twice = debit.clone();
/// ```
///
/// ```compile_fail,E0382
/// use anchor_lang::prelude::Pubkey;
/// use buckspay::state::Ledger;
/// let mut ledger = Ledger::new(10, 10, Pubkey::default(), [2; 33], 0, 255);
/// let debit = ledger.pay_backing(5).unwrap();
/// let first = debit;
/// let second = debit;
/// ```
///
/// A `Debit` that is dropped unused is a compile error under `#![deny(unused_must_use)]`:
///
/// ```compile_fail
/// #![deny(unused_must_use)]
/// use anchor_lang::prelude::Pubkey;
/// use buckspay::state::Ledger;
/// let mut ledger = Ledger::new(10, 10, Pubkey::default(), [2; 33], 0, 255);
/// ledger.pay_backing(5).unwrap();
/// ```
#[derive(Debug)]
#[must_use = "a Debit authorises a payout: pass it to payout::pay_out"]
pub struct Debit {
    amount: u64,
}

impl Debit {
    fn new(amount: u64) -> Self {
        Self { amount }
    }

    pub fn amount(&self) -> u64 {
        self.amount
    }

    pub(crate) fn into_amount(self) -> u64 {
        self.amount
    }
}

impl Ledger {
    pub fn new(
        bond: u64,
        backing: u64,
        payer: Pubkey,
        key: [u8; 33],
        lock_seq: u32,
        bump: u8,
    ) -> Self {
        Self {
            backing_left: backing,
            bond_free: bond,
            bond_slashed: 0,
            payer,
            key,
            lock_seq,
            withdrawn: false,
            bump,
        }
    }

    /// `backing_left + bond_free + bond_slashed`; `Err(AmountOverflow)` if it exceeds `u64`.
    pub fn reserved(&self) -> Result<u64> {
        self.backing_left
            .checked_add(self.bond_free)
            .and_then(|sum| sum.checked_add(self.bond_slashed))
            .ok_or_else(|| error!(BuckspayError::AmountOverflow))
    }

    /// A settlement or reclaim takes `amount` from the backing.
    /// Adds to the free stake of an attester's ledger. A lock's bond is fixed by its record for ever,
    /// so only a ledger marked as an attester's can grow.
    pub fn add_stake(&mut self, amount: u64) -> Result<()> {
        require!(
            self.key[0] == ATTESTER_LEDGER_MARKER,
            BuckspayError::AttesterStatus
        );
        require!(amount > 0, BuckspayError::AmountZero);
        self.bond_free = self
            .bond_free
            .checked_add(amount)
            .ok_or_else(|| error!(BuckspayError::AmountOverflow))?;
        Ok(())
    }

    /// Records what a settlement paid into a reward pool's escrow.
    pub fn credit_reward(&mut self, amount: u64) -> Result<()> {
        require!(
            self.key[0] == REWARD_LEDGER_MARKER,
            BuckspayError::NotRewardPool
        );
        require!(amount > 0, BuckspayError::AmountZero);
        self.backing_left = self
            .backing_left
            .checked_add(amount)
            .ok_or_else(|| error!(BuckspayError::AmountOverflow))?;
        Ok(())
    }

    pub fn pay_backing(&mut self, amount: u64) -> Result<Debit> {
        require!(amount > 0, BuckspayError::AmountZero);
        self.backing_left = self
            .backing_left
            .checked_sub(amount)
            .ok_or_else(|| error!(BuckspayError::InsufficientEscrow))?;
        Ok(Debit::new(amount))
    }

    /// A slash moves `amount` of the free bond into the pool. No tokens move.
    pub fn commit_slash(&mut self, amount: u64) -> Result<()> {
        require!(amount > 0, BuckspayError::AmountZero);
        let free = self
            .bond_free
            .checked_sub(amount)
            .ok_or_else(|| error!(BuckspayError::InsufficientEscrow))?;
        let slashed = self
            .bond_slashed
            .checked_add(amount)
            .ok_or_else(|| error!(BuckspayError::AmountOverflow))?;
        self.bond_free = free;
        self.bond_slashed = slashed;
        Ok(())
    }

    /// A claim or the burn takes `amount` out of the pool.
    pub fn pay_slashed(&mut self, amount: u64) -> Result<Debit> {
        require!(amount > 0, BuckspayError::AmountZero);
        self.bond_slashed = self
            .bond_slashed
            .checked_sub(amount)
            .ok_or_else(|| error!(BuckspayError::InsufficientEscrow))?;
        Ok(Debit::new(amount))
    }

    /// After the claim window the pool's residue returns to the free bond. No tokens move.
    pub fn release_slashed(&mut self, amount: u64) -> Result<()> {
        require!(amount > 0, BuckspayError::AmountZero);
        let pool = self
            .bond_slashed
            .checked_sub(amount)
            .ok_or_else(|| error!(BuckspayError::InsufficientEscrow))?;
        let free = self
            .bond_free
            .checked_add(amount)
            .ok_or_else(|| error!(BuckspayError::AmountOverflow))?;
        self.bond_slashed = pool;
        self.bond_free = free;
        Ok(())
    }

    /// Requires `escrow_amount >= reserved()`; empties backing and free bond, sets `withdrawn` and
    /// authorises `escrow_amount - bond_slashed` (the pool stays). May be called again to sweep
    /// donations or released residue; the amount can then be zero, which `pay_out` rejects.
    pub fn drain(&mut self, escrow_amount: u64) -> Result<Debit> {
        let reserved = self.reserved()?;
        require!(escrow_amount >= reserved, BuckspayError::InsufficientEscrow);
        let out = escrow_amount
            .checked_sub(self.bond_slashed)
            .ok_or_else(|| error!(BuckspayError::InsufficientEscrow))?;
        self.backing_left = 0;
        self.bond_free = 0;
        self.withdrawn = true;
        Ok(Debit::new(out))
    }
}

/// After any token movement: reload the escrow and call this.
pub fn assert_solvent(ledger: &Ledger, escrow_amount: u64) -> Result<()> {
    require!(
        escrow_amount >= ledger.reserved()?,
        BuckspayError::InsufficientEscrow
    );
    Ok(())
}
