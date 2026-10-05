mod common;
use common::*;
use proptest::prelude::*;

#[derive(Clone, Debug)]
enum Step {
    NewLock {
        user: usize,
        bond: u64,
        backing: u64,
        days: u32,
    },
    Warp {
        days: u32,
    },
    Withdraw {
        lock: usize,
        wrong_wallet: bool,
    },
    Release {
        lock: usize,
    },
    Slash {
        lock: usize,
        amount: u64,
    },
    PayBacking {
        lock: usize,
        amount: u64,
    },
    PaySlashed {
        lock: usize,
        amount: u64,
    },
    ReleaseSlashed {
        lock: usize,
        amount: u64,
    },
    Donate {
        lock: usize,
        amount: u64,
    },
    Close {
        lock: usize,
    },
}

fn step() -> impl Strategy<Value = Step> {
    let amount = || prop_oneof![3 => 0u64..=50, 1 => Just(u64::MAX), 1 => 0u64..=1_000];
    prop_oneof![
        4 => (0usize..2, amount(), amount(), 16u32..=366).prop_map(|(user, bond, backing, days)| Step::NewLock { user, bond, backing, days }),
        3 => (1u32..=60).prop_map(|days| Step::Warp { days }),
        3 => (0usize..6, any::<bool>()).prop_map(|(lock, wrong_wallet)| Step::Withdraw { lock, wrong_wallet }),
        2 => (0usize..6).prop_map(|lock| Step::Release { lock }),
        2 => (0usize..6, amount()).prop_map(|(lock, amount)| Step::Slash { lock, amount }),
        2 => (0usize..6, amount()).prop_map(|(lock, amount)| Step::PayBacking { lock, amount }),
        2 => (0usize..6, amount()).prop_map(|(lock, amount)| Step::PaySlashed { lock, amount }),
        2 => (0usize..6, amount()).prop_map(|(lock, amount)| Step::ReleaseSlashed { lock, amount }),
        1 => (0usize..6, 0u64..=20).prop_map(|(lock, amount)| Step::Donate { lock, amount }),
        2 => (0usize..6).prop_map(|lock| Step::Close { lock }),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]
    #[test]
    fn no_sequence_of_transactions_breaks_conservation(steps in proptest::collection::vec(step(), 1..24)) {
        let mut env = Env::new(TokenKind::Classic);
        let users = [env.user(10_000), env.user(10_000)];
        let supply = env.total_supply();
        let mut locks: Vec<(usize, Lock)> = Vec::new();

        for s in steps {
            let before = env.snapshot();
            let outcome = match s {
                Step::NewLock { user, bond, backing, days } => {
                    let until = env.now() + days * 86_400;
                    match env.try_lock(&users[user], bond, backing, until) {
                        Ok(lock) => { locks.push((user, lock)); Ok(()) }
                        Err(e) => Err(e),
                    }
                }
                Step::Warp { days } => { env.warp(i64::from(env.now()) + i64::from(days) * 86_400); Ok(()) }
                Step::Withdraw { lock, wrong_wallet } => locks.get(lock).map_or(Ok(()), |(owner, l)| {
                    let signer = if wrong_wallet { 1 - *owner } else { *owner };
                    env.try_withdraw(&users[*owner], &users[signer], l)
                }),
                Step::Release { lock } => locks.get(lock).map_or(Ok(()), |(o, l)| env.try_release(&users[*o], l)),
                Step::Slash { lock, amount } => locks.get(lock).map_or(Ok(()), |(_, l)| env.try_edit(&l.address, |g| g.commit_slash(amount))),
                Step::PayBacking { lock, amount } => locks.get(lock).map_or(Ok(()), |(_, l)| env.try_pay(l, |g| g.pay_backing(amount))),
                Step::PaySlashed { lock, amount } => locks.get(lock).map_or(Ok(()), |(_, l)| env.try_pay(l, |g| g.pay_slashed(amount))),
                Step::ReleaseSlashed { lock, amount } => locks.get(lock).map_or(Ok(()), |(_, l)| env.try_edit(&l.address, |g| g.release_slashed(amount))),
                Step::Donate { lock, amount } => { if let Some((_, l)) = locks.get(lock) { env.donate(l, amount) }; Ok(()) }
                Step::Close { lock } => locks.get(lock).map_or(Ok(()), |(o, l)| env.try_close(&users[*o], l)),
            };
            if outcome.is_err() {
                prop_assert_eq!(env.snapshot(), before, "a refused transaction changes nothing: {:?}", s);
            }
            for (_, l) in &locks {
                if let Some(ledger) = env.try_ledger(&l.address) {
                    let held = env.balance_or_zero(&l.escrow);
                    prop_assert!(held >= ledger.reserved().unwrap(), "escrow covers the ledger");
                    prop_assert!(ledger.backing_left <= l.backing);
                    prop_assert!(ledger.withdrawn || ledger.bond_free + ledger.bond_slashed <= l.bond);
                    prop_assert!(!ledger.withdrawn || ledger.backing_left == 0);
                }
            }
            prop_assert_eq!(env.total_supply(), supply);
            prop_assert_eq!(env.circulating(&users) + env.in_escrows(&locks) + env.paid_out(), supply);
        }
    }
}
