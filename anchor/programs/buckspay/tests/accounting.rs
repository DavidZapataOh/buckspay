use anchor_lang::prelude::Pubkey;
use buckspay::state::Ledger;
use proptest::prelude::*;

#[derive(Clone, Debug)]
enum Op {
    PayBacking(u64),
    CommitSlash(u64),
    PaySlashed(u64),
    ReleaseSlashed(u64),
    Donate(u64),
    Drain,
}

fn amount() -> impl Strategy<Value = u64> {
    prop_oneof![
        4 => 0u64..=1_000,
        2 => 0u64..=1_000_000_000,
        1 => Just(u64::MAX),
        1 => Just(u64::MAX - 1),
        1 => (0u64..=8).prop_map(|d| u64::MAX / 2 + d),
    ]
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        4 => amount().prop_map(Op::PayBacking),
        4 => amount().prop_map(Op::CommitSlash),
        3 => amount().prop_map(Op::PaySlashed),
        2 => amount().prop_map(Op::ReleaseSlashed),
        1 => (0u64..=1_000).prop_map(Op::Donate),
        1 => Just(Op::Drain),
    ]
}

fn ledger(bond: u64, backing: u64) -> Ledger {
    Ledger::new(bond, backing, Pubkey::default(), [2; 33], 0, 255)
}

/// The token account plus ghost sums the ledger itself does not keep. The expectations are
/// derived from the *accepted operations*, never from the ledger under test.
struct World {
    ledger: Ledger,
    escrow: u128,
    bond: u64,
    backing: u64,
    paid_backing: u128,
    paid_bond: u128,
    to_wallet: u128,
    donated: u128,
    committed: u128, // every amount a commit_slash accepted
    released: u128,  // every amount a release_slashed accepted
}

impl World {
    fn new(bond: u64, backing: u64) -> Self {
        Self {
            ledger: ledger(bond, backing),
            escrow: u128::from(bond) + u128::from(backing),
            bond,
            backing,
            paid_backing: 0,
            paid_bond: 0,
            to_wallet: 0,
            donated: 0,
            committed: 0,
            released: 0,
        }
    }

    fn apply(&mut self, op: &Op) {
        let before = self.ledger.clone();
        match *op {
            Op::PayBacking(a) => match self.ledger.pay_backing(a) {
                Ok(debit) => {
                    assert_eq!(
                        debit.amount(),
                        a,
                        "the debit is exactly what the bucket gave up"
                    );
                    self.escrow -= u128::from(debit.amount());
                    self.paid_backing += u128::from(debit.amount());
                    assert_eq!(self.ledger.backing_left, before.backing_left - a);
                }
                Err(_) => assert_eq!(self.ledger, before),
            },
            Op::CommitSlash(a) => match self.ledger.commit_slash(a) {
                Ok(()) => {
                    self.committed += u128::from(a);
                    // The pool grows by exactly the amount and the free bond shrinks by it.
                    assert_eq!(self.ledger.bond_slashed, before.bond_slashed + a);
                    assert_eq!(self.ledger.bond_free, before.bond_free - a);
                }
                Err(_) => assert_eq!(self.ledger, before),
            },
            Op::PaySlashed(a) => match self.ledger.pay_slashed(a) {
                Ok(debit) => {
                    assert_eq!(
                        debit.amount(),
                        a,
                        "the debit is exactly what the pool gave up"
                    );
                    self.escrow -= u128::from(debit.amount());
                    self.paid_bond += u128::from(debit.amount());
                    assert_eq!(self.ledger.bond_slashed, before.bond_slashed - a);
                    assert_eq!(self.ledger.bond_free, before.bond_free);
                }
                Err(_) => assert_eq!(self.ledger, before),
            },
            Op::ReleaseSlashed(a) => match self.ledger.release_slashed(a) {
                Ok(()) => {
                    self.released += u128::from(a);
                    assert_eq!(self.ledger.bond_slashed, before.bond_slashed - a);
                    assert_eq!(self.ledger.bond_free, before.bond_free + a);
                }
                Err(_) => assert_eq!(self.ledger, before),
            },
            Op::Donate(a) => {
                // A token account cannot hold more than u64::MAX.
                if self.escrow + u128::from(a) <= u128::from(u64::MAX) {
                    self.escrow += u128::from(a);
                    self.donated += u128::from(a);
                }
            }
            Op::Drain => match self.ledger.drain(u64::try_from(self.escrow).unwrap()) {
                Ok(debit) => {
                    let out = debit.amount();
                    assert_eq!(
                        u128::from(out),
                        self.escrow - u128::from(before.bond_slashed),
                        "a drain authorises everything but the pool"
                    );
                    self.escrow -= u128::from(out);
                    self.to_wallet += u128::from(out);
                    assert_eq!(self.escrow, u128::from(self.ledger.bond_slashed));
                }
                Err(_) => assert_eq!(self.ledger, before),
            },
        }
    }

    fn check(&self) {
        let l = &self.ledger;
        let reserved = u128::from(l.reserved().unwrap());
        assert!(self.escrow >= reserved, "the escrow covers every bucket");
        assert!(
            self.paid_backing <= u128::from(self.backing),
            "payouts <= backing"
        );
        // Slashing plus claims never exceed the bond: everything committed is either still in the
        // pool, paid out, or released back; and nothing was ever committed twice.
        assert_eq!(
            self.committed,
            u128::from(l.bond_slashed) + self.paid_bond + self.released,
            "ghost sum of committed slashes"
        );
        assert!(
            self.committed <= u128::from(self.bond) + self.released,
            "slashed more than the bond held"
        );
        assert!(self.paid_bond <= u128::from(self.bond), "claims <= bond");
        assert_eq!(
            u128::from(self.bond) + u128::from(self.backing) + self.donated,
            self.escrow + self.paid_backing + self.paid_bond + self.to_wallet,
            "conservation: every unit is in the escrow or was paid out"
        );
        if !l.withdrawn {
            assert_eq!(
                u128::from(l.bond_free) + u128::from(l.bond_slashed) + self.paid_bond,
                u128::from(self.bond),
                "the bond is exactly free + pool + paid"
            );
        } else {
            // Nothing refills the backing; only a release from the pool can refill the free bond,
            // and a second drain sweeps it.
            assert_eq!(l.backing_left, 0);
            assert!(self.escrow >= u128::from(l.bond_slashed));
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(4096))]
    #[test]
    fn no_sequence_breaks_the_buckets(
        bond in prop_oneof![0u64..=1_000_000, Just(u64::MAX / 2)],
        backing in prop_oneof![0u64..=1_000_000, Just(u64::MAX / 2)],
        ops in proptest::collection::vec(op(), 0..64),
    ) {
        let mut world = World::new(bond, backing);
        world.check();
        for op in &ops {
            world.apply(op);
            world.check();
        }
    }
}

#[test]
fn zero_amounts_are_rejected_everywhere() {
    let mut l = ledger(10, 10);
    assert!(l.pay_backing(0).is_err());
    assert!(l.commit_slash(0).is_err());
    assert!(l.pay_slashed(0).is_err());
    assert!(l.release_slashed(0).is_err());
}

#[test]
fn a_slash_cannot_exceed_the_free_bond_and_a_claim_cannot_exceed_the_pool() {
    let mut l = ledger(100, 0);
    l.commit_slash(60).unwrap();
    assert!(l.commit_slash(41).is_err());
    assert!(l.pay_slashed(61).is_err());
    assert_eq!(l.pay_slashed(60).unwrap().amount(), 60);
    assert_eq!((l.bond_free, l.bond_slashed), (40, 0));
}

#[test]
fn two_slashes_add_up() {
    let mut l = ledger(100, 0);
    l.commit_slash(10).unwrap();
    l.commit_slash(20).unwrap();
    assert_eq!((l.bond_free, l.bond_slashed), (70, 30));
}

#[test]
fn the_pool_residue_goes_back_to_the_free_bond_and_is_withdrawable() {
    let mut l = ledger(100, 50);
    l.commit_slash(40).unwrap();
    assert_eq!(l.pay_slashed(25).unwrap().amount(), 25); // claims paid 25 of 40 (escrow now holds 125)
    assert!(l.release_slashed(16).is_err());
    l.release_slashed(15).unwrap();
    assert_eq!((l.bond_free, l.bond_slashed), (75, 0));
    assert_eq!(l.drain(125).unwrap().amount(), 125);
}

#[test]
fn drain_leaves_the_pool_and_refuses_an_escrow_that_owes_more_than_it_holds() {
    let mut l = ledger(100, 50);
    l.commit_slash(30).unwrap();
    assert!(l.clone().drain(149).is_err()); // 150 reserved
    assert_eq!(l.drain(155).unwrap().amount(), 125); // 155 - 30 pool, donation included
    assert!(l.withdrawn);
    assert_eq!(l.drain(30).unwrap().amount(), 0); // a second call sweeps nothing and changes nothing
}

#[test]
fn reserved_reports_overflow_instead_of_wrapping() {
    let mut l = ledger(u64::MAX, 1);
    assert!(l.reserved().is_err());
    assert!(l.pay_backing(1).is_ok());
}

#[test]
fn assert_solvent_matches_reserved() {
    let l = ledger(5, 7);
    assert!(buckspay::accounting::assert_solvent(&l, 12).is_ok());
    assert!(buckspay::accounting::assert_solvent(&l, 11).is_err());
}
