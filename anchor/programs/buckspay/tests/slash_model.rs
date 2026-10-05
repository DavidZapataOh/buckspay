//! The burn of a claim against the `Ledger`, for any sequence of operations: nothing leaves the
//! lock except the backing, the withdrawal and the burn, a claim burns what `slash::penalty` says
//! and never more than the free bond, and no claim ever pays anybody. The economic claims of the
//! design are properties of the same code: a culprit within the exposure of its bond loses at least
//! twice what it stole whatever claims anybody adds, and what a lock loses to claims does not
//! depend on who files them or in what order.
use anchor_lang::prelude::Pubkey;
use buckspay::{accounting::Debit, burn::burn_for, state::Ledger};
use buckspay_protocol::slash;
use proptest::prelude::*;

#[derive(Clone, Debug)]
enum Op {
    PayBacking(u64),
    Claim(u64),
    Donate(u64),
    Withdraw,
}

fn amount() -> impl Strategy<Value = u64> {
    prop_oneof![
        4 => 1u64..=1_000,
        2 => 1u64..=1_000_000_000,
        1 => Just(u64::MAX),
        1 => (0u64..=8).prop_map(|d| u64::MAX / 2 + d),
    ]
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        4 => amount().prop_map(Op::PayBacking),
        8 => amount().prop_map(Op::Claim),
        1 => (0u64..=1_000).prop_map(Op::Donate),
        1 => Just(Op::Withdraw),
    ]
}

struct World {
    ledger: Ledger,
    /// What the escrow token account holds.
    escrow: u128,
    bond: u64,
    paid_backing: u128,
    burned: u128,
    withdrawn: u128,
    claimed: u128,
    donated: u128,
    start: u128,
}

impl World {
    fn new(bond: u64, backing: u64) -> Self {
        // The escrow is a token account: `u64`.
        let backing = backing.min(u64::MAX - bond);
        Self {
            ledger: Ledger::new(bond, backing, Pubkey::default(), [2; 33], 0, 255),
            escrow: u128::from(bond) + u128::from(backing),
            bond,
            paid_backing: 0,
            burned: 0,
            withdrawn: 0,
            claimed: 0,
            donated: 0,
            start: u128::from(bond) + u128::from(backing),
        }
    }

    fn take(&mut self, debit: Debit) -> u64 {
        let amount = debit.amount();
        self.escrow -= u128::from(amount);
        drop(debit);
        amount
    }

    fn claim(&mut self, loss: u64) -> Option<u64> {
        let free = self.ledger.bond_free;
        let before = self.ledger.clone();
        match burn_for(&mut self.ledger, loss) {
            Ok(debit) => {
                let burn = self.take(debit);
                assert_eq!(burn, slash::penalty(loss, free));
                assert!(burn > 0 && burn <= free);
                assert_eq!(self.ledger.bond_free, free - burn);
                assert_eq!(self.ledger.bond_slashed, 0, "no pool outlives a claim");
                assert_eq!(self.ledger.backing_left, before.backing_left);
                self.burned += u128::from(burn);
                self.claimed += u128::from(loss);
                Some(burn)
            }
            Err(_) => {
                // Refused only for a zero loss or an empty bond, and then nothing changed.
                assert!(loss == 0 || free == 0);
                assert_eq!(self.ledger, before);
                None
            }
        }
    }

    fn apply(&mut self, op: &Op) {
        match *op {
            Op::PayBacking(a) => {
                let before = self.ledger.clone();
                match self.ledger.pay_backing(a) {
                    Ok(debit) => self.paid_backing += u128::from(self.take(debit)),
                    Err(_) => assert_eq!(self.ledger, before),
                }
            }
            Op::Claim(loss) => {
                self.claim(loss);
            }
            Op::Donate(a) => {
                if self.escrow + u128::from(a) <= u128::from(u64::MAX) {
                    self.escrow += u128::from(a);
                    self.donated += u128::from(a);
                }
            }
            Op::Withdraw => {
                let before = self.ledger.clone();
                let escrow = u64::try_from(self.escrow).unwrap_or(u64::MAX);
                match self.ledger.drain(escrow) {
                    Ok(debit) if debit.amount() > 0 => {
                        self.withdrawn += u128::from(self.take(debit));
                    }
                    Ok(debit) => drop(debit),
                    Err(_) => assert_eq!(self.ledger, before),
                }
            }
        }
    }

    fn check(&self) {
        let ledger = &self.ledger;
        // The escrow holds at least what the ledger owes, and nothing is owed to a pool.
        assert_eq!(ledger.bond_slashed, 0);
        assert!(self.escrow >= u128::from(ledger.reserved().unwrap()));
        // What left the escrow is accounted for: backing paid, burned or withdrawn, and nothing else.
        assert_eq!(
            self.escrow + self.paid_backing + self.withdrawn + self.burned,
            self.start + self.donated
        );
        // The claims burned at most what the bond was and at most twice what they claimed.
        assert!(self.burned <= u128::from(self.bond));
        assert!(self.burned <= 2 * self.claimed);
        // The bond is never burned more than once: burned plus free never exceeds it.
        assert!(self.burned + u128::from(ledger.bond_free) <= u128::from(self.bond));
    }
}

/// A zero loss is refused as a zero loss, not as an empty bond.
#[test]
fn a_zero_loss_is_refused_as_zero_and_an_empty_bond_as_empty() {
    let name = |loss: u64, bond: u64| {
        let mut ledger = Ledger::new(bond, 0, Pubkey::default(), [2; 33], 0, 255);
        match burn_for(&mut ledger, loss).unwrap_err() {
            anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(name(0, 100), u32::from(buckspay::BuckspayError::AmountZero));
    assert_eq!(name(5, 0), u32::from(buckspay::BuckspayError::NoBond));
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(4096))]

    /// Whatever the order of claims, backing payments, donations and withdrawals: the escrow
    /// always covers the ledger, the burn leaves it and nothing else is paid because of a claim.
    #[test]
    fn nothing_leaves_a_lock_but_the_backing_the_withdrawal_and_the_burn(
        bond in amount(), backing in amount(), ops in proptest::collection::vec(op(), 0..60),
    ) {
        let mut w = World::new(bond, backing);
        for op in &ops {
            w.apply(op);
            w.check();
        }
        prop_assert_eq!(
            w.escrow + w.paid_backing + w.withdrawn + w.burned,
            w.start + w.donated
        );
    }

    /// A culprit that steals no more than the exposure of its bond, in whatever pieces, loses at
    /// least twice what it stole, whatever claims anybody adds before, between or after and
    /// whoever files them: the burn is the bond or twice everything claimed, and the claims of the
    /// culprit's own accounts only make it larger.
    #[test]
    fn a_culprit_within_the_exposure_loses_twice_what_it_stole_whatever_is_filed(
        bond in 1_000u64..=u64::MAX / 4,
        stolen_pieces in proptest::collection::vec(any::<u64>(), 1..6),
        extra in proptest::collection::vec(1u64..=u64::MAX / 64, 0..8),
        order in any::<u64>(),
    ) {
        let mut left = slash::exposure(bond);
        let mut real = vec![];
        for piece in stolen_pieces {
            let loss = 1 + piece % left.max(1);
            if loss <= left {
                left -= loss;
                real.push(loss);
            }
        }
        prop_assume!(!real.is_empty());
        let stolen: u128 = real.iter().map(|&l| u128::from(l)).sum();
        let mut losses: Vec<u64> = real.iter().chain(&extra).copied().collect();
        // A deterministic shuffle: the order is the culprit's choice.
        let n = losses.len();
        for i in 0..n {
            losses.swap(i, (order.rotate_left(i as u32) % n as u64) as usize);
        }
        let mut w = World::new(bond, 0);
        for loss in &losses {
            w.claim(*loss);
        }
        prop_assert!(
            w.burned >= 2 * stolen,
            "bond {bond} stole {stolen} burned {} claims {:?}", w.burned, losses
        );
        prop_assert!(w.burned <= u128::from(bond));
    }

    /// What a lock loses to claims depends on the set of claims only: not on the order, not on who
    /// files them. It is `min(bond, 2 * claims)` for claims whose total fits and the bond when it
    /// does not.
    #[test]
    fn what_a_lock_loses_does_not_depend_on_the_order_or_the_filer(
        bond in amount(),
        losses in proptest::collection::vec(1u64..=u64::MAX / 128, 1..10),
        seed in any::<u64>(),
    ) {
        let total: u128 = losses.iter().map(|&l| u128::from(l)).sum();
        let burned = |losses: &[u64]| {
            let mut w = World::new(bond, 0);
            for loss in losses {
                w.claim(*loss);
            }
            w.burned
        };
        let expected = (2 * total).min(u128::from(bond));
        prop_assert_eq!(burned(&losses), expected);
        let mut shuffled = losses.clone();
        for i in 0..shuffled.len() {
            let j = (seed.rotate_left(i as u32 * 7) % shuffled.len() as u64) as usize;
            shuffled.swap(i, j);
        }
        prop_assert_eq!(burned(&shuffled), expected);
    }

    /// Claims the culprit adds never lower the burn: filing more cannot help whoever is blamed.
    #[test]
    fn adding_a_claim_never_lowers_what_burns(
        bond in amount(),
        losses in proptest::collection::vec(1u64..=u64::MAX / 128, 0..8),
        added in 1u64..=u64::MAX / 128,
    ) {
        let burned = |losses: &[u64]| {
            let mut w = World::new(bond, 0);
            for loss in losses {
                w.claim(*loss);
            }
            w.burned
        };
        let mut more = losses.clone();
        more.push(added);
        prop_assert!(burned(&more) >= burned(&losses));
    }

    /// The exposure is exact: `n` thefts of the payment limit lose, break even or profit as the
    /// number passes 3 and 4, for any bond that is a multiple of four limits.
    #[test]
    fn the_limit_of_four_payments_is_exact(unit in 1u64..=1_000_000_000) {
        let limit = unit;
        let bond = 4 * limit;
        prop_assert_eq!(slash::payment_limit(bond), limit);
        let mut nets = vec![];
        for n in 1u64..=6 {
            let mut w = World::new(bond, 0);
            for _ in 0..n {
                w.claim(limit);
            }
            nets.push(i128::from(n * limit) - w.burned as i128);
        }
        let l = i128::from(limit);
        prop_assert_eq!(nets, vec![-l, -2 * l, -l, 0, l, 2 * l]);
    }
}
