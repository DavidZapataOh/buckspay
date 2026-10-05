//! The stake of an attester against the `Ledger`, for any sequence of operations: nothing leaves it
//! except the burn of a report and the withdrawal, a report destroys exactly what was staked, a
//! slashed attester never stakes again, and nobody is paid out of a burn.
use anchor_lang::prelude::Pubkey;
use buckspay::{
    accounting::Debit,
    burn::burn_for,
    state::{Ledger, ATTESTER_LEDGER_MARKER},
};
use proptest::prelude::*;

#[derive(Clone, Debug)]
enum Op {
    TopUp(u64),
    Donate(u64),
    Report,
    Withdraw,
}

fn amount() -> impl Strategy<Value = u64> {
    prop_oneof![
        4 => 1u64..=1_000,
        2 => 1u64..=1_000_000_000,
        1 => Just(u64::MAX),
    ]
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        6 => amount().prop_map(Op::TopUp),
        2 => (0u64..=1_000).prop_map(Op::Donate),
        2 => Just(Op::Report),
        1 => Just(Op::Withdraw),
    ]
}

proptest! {
    #[test]
    fn the_stake_is_conserved_and_a_report_destroys_all_of_it(
        start in 1u64..=1_000_000_000_000,
        ops in proptest::collection::vec(op(), 0..60),
    ) {
        let mut marker = [0; 33];
        marker[0] = ATTESTER_LEDGER_MARKER;
        let mut ledger = Ledger::new(start, 0, Pubkey::default(), marker, 1, 255);
        let mut escrow = u128::from(start);
        let (mut burned, mut withdrawn, mut donated, mut deposited) =
            (0u128, 0u128, 0u128, u128::from(start));
        let (mut slashed, mut retired) = (false, false);
        for op in ops {
            if retired {
                break;
            }
            match op {
                Op::TopUp(a) => {
                    let ok = !slashed && escrow + u128::from(a) <= u128::from(u64::MAX)
                        && ledger.clone().add_stake(a).is_ok();
                    if ok {
                        ledger.add_stake(a).unwrap();
                        escrow += u128::from(a);
                        deposited += u128::from(a);
                    }
                }
                Op::Donate(a) => {
                    escrow += u128::from(a);
                    donated += u128::from(a);
                }
                Op::Report if !slashed => {
                    let free = ledger.bond_free;
                    match burn_for(&mut ledger, free) {
                        Ok(debit) => {
                            let debit: Debit = debit;
                            prop_assert_eq!(debit.amount(), free);
                            burned += u128::from(debit.amount());
                            escrow -= u128::from(debit.amount());
                            slashed = true;
                        }
                        Err(_) => prop_assert_eq!(free, 0),
                    }
                }
                Op::Report => {}
                Op::Withdraw => {
                    let debit = ledger.drain(u64::try_from(escrow).unwrap()).unwrap();
                    withdrawn += u128::from(debit.amount());
                    escrow -= u128::from(debit.amount());
                    retired = true;
                }
            }
            prop_assert!(escrow >= u128::from(ledger.reserved().unwrap()));
            prop_assert_eq!(ledger.bond_slashed, 0);
            prop_assert_eq!(deposited + donated, escrow + burned + withdrawn);
            if slashed {
                prop_assert_eq!(ledger.bond_free, 0);
            }
        }
    }
}
