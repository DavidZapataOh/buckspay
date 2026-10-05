use buckspay_protocol::{
    chain::{hop, Output},
    lock::EXPIRY_STEP,
    Caveats, Outputs, Owner, ProtocolError, ScopeKind, Spend,
};
use proptest::prelude::*;

fn caveats(expiry: u32, hops_left: u8) -> Caveats {
    Caveats {
        expiry,
        hops_left,
        flags: 0,
        scope_kind: ScopeKind::Any,
        scope: [0; 20],
    }
}

fn input(expiry: u32) -> Output {
    Output {
        id: [1; 32],
        owner: Owner::Device([2; 33]),
        amount: 100,
        caveats: caveats(expiry, 4),
    }
}

fn pay(owner: Owner, expiry: u32) -> Spend {
    Spend {
        input: [1; 32],
        lock_seq: 0,
        salt: [0; 16],
        outputs: Outputs::One {
            owner,
            caveats: caveats(expiry, 3),
        },
    }
}

const PARENT: u32 = 1_900_000_000;
const DEVICE: Owner = Owner::Device([3; 33]);
const ACCOUNT: Owner = Owner::Account([4; 32]);

#[test]
fn a_payment_to_a_device_steps_down_by_exactly_the_step() {
    let input = input(PARENT);
    assert!(hop(&input, &pay(DEVICE, PARENT - EXPIRY_STEP)).is_ok());
    assert_eq!(
        hop(&input, &pay(DEVICE, PARENT - EXPIRY_STEP + 1)),
        Err(ProtocolError::ExpiryStep)
    );
    assert_eq!(
        hop(&input, &pay(DEVICE, PARENT)),
        Err(ProtocolError::ExpiryStep)
    );
}

#[test]
fn a_later_expiry_is_still_an_attenuation_failure() {
    assert_eq!(
        hop(&input(PARENT), &pay(DEVICE, PARENT + 1)),
        Err(ProtocolError::Attenuation)
    );
}

#[test]
fn a_payment_to_a_terminal_account_is_free_of_the_step() {
    let input = input(PARENT);
    assert!(hop(&input, &pay(ACCOUNT, PARENT)).is_ok());
    assert!(hop(&input, &pay(ACCOUNT, PARENT - 1)).is_ok());
    assert_eq!(
        hop(&input, &pay(ACCOUNT, PARENT + 1)),
        Err(ProtocolError::Attenuation)
    );
}

#[test]
fn the_change_keeps_the_inputs_expiry_and_the_payment_steps_down() {
    let input = input(PARENT);
    let split = Spend {
        outputs: Outputs::Two {
            owner0: DEVICE,
            amount0: 40,
            caveats0: caveats(PARENT - EXPIRY_STEP, 3),
            owner1: input.owner,
        },
        ..pay(DEVICE, 0)
    };
    let (_, amount, caveats0, change) = hop(&input, &split).unwrap();
    assert_eq!((amount, caveats0.expiry), (40, PARENT - EXPIRY_STEP));
    let (change_amount, change_caveats) = change.unwrap();
    assert_eq!((change_amount, change_caveats.expiry), (60, PARENT));
    let same = Spend {
        outputs: Outputs::Two {
            owner0: DEVICE,
            amount0: 40,
            caveats0: caveats(PARENT, 3),
            owner1: input.owner,
        },
        ..pay(DEVICE, 0)
    };
    assert_eq!(hop(&input, &same), Err(ProtocolError::ExpiryStep));
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(50_000))]

    /// Whatever the two expiries, a hop to a device is accepted exactly when the child expires at
    /// least `EXPIRY_STEP` before its input, and a hop to an account whenever the child does not
    /// outlive it.
    #[test]
    fn the_step_rule_is_exact(parent in any::<u32>(), child in any::<u32>(), to_device in any::<bool>()) {
        let owner = if to_device { DEVICE } else { ACCOUNT };
        let result = hop(&input(parent), &pay(owner, child));
        let steps = u64::from(child) + u64::from(EXPIRY_STEP) <= u64::from(parent);
        let expected = if child > parent {
            Err(ProtocolError::Attenuation)
        } else if to_device && !steps {
            Err(ProtocolError::ExpiryStep)
        } else {
            Ok(())
        };
        prop_assert_eq!(result.map(drop), expected);
    }
}
