use anchor_lang::{prelude::Pubkey, Space};
use buckspay::state::{Device, Ledger, Lock, Rotation};
use buckspay::state::{DEVICE_SEED, ESCROW_SEED, LEDGER_SEED, LOCK_SEED, ROTATION_SEED};
use proptest::prelude::*;

const PREFIXES: [&[u8]; 5] = [
    DEVICE_SEED,
    ROTATION_SEED,
    LOCK_SEED,
    LEDGER_SEED,
    ESCROW_SEED,
];

fn key33() -> impl Strategy<Value = [u8; 33]> {
    proptest::collection::vec(any::<u8>(), 33).prop_map(|v| v.try_into().unwrap())
}

fn key_seeds(key: &[u8; 33]) -> (&[u8], &[u8]) {
    (&key[..1], &key[1..])
}

#[test]
fn account_sizes_are_the_documented_ones() {
    assert_eq!(8 + Device::INIT_SPACE, 49);
    assert_eq!(8 + Lock::INIT_SPACE, 61);
    assert_eq!(8 + Ledger::INIT_SPACE, 103);
    assert_eq!(8 + Rotation::INIT_SPACE, 77);
}

#[test]
fn no_seed_prefix_is_a_prefix_of_another() {
    for (i, a) in PREFIXES.iter().enumerate() {
        for (j, b) in PREFIXES.iter().enumerate() {
            if i != j {
                assert!(!b.starts_with(a), "{:?} starts with {:?}", b, a);
            }
        }
    }
}

#[test]
fn every_seed_fits_the_32_byte_limit() {
    for prefix in PREFIXES {
        assert!(prefix.len() <= 32);
    }
    let key = [3u8; 33];
    let (head, tail) = key_seeds(&key);
    assert_eq!(
        (head.len(), tail.len(), 0u32.to_le_bytes().len()),
        (1, 32, 4)
    );
    assert!(Pubkey::try_find_program_address(
        &[LOCK_SEED, head, tail, &u32::MAX.to_le_bytes()],
        &buckspay::ID
    )
    .is_some());
}

proptest! {
    #[test]
    fn distinct_keys_and_sequences_never_share_a_lock_address(
        a in key33(), b in key33(), sa in 0u32..u32::MAX, sb in 0u32..u32::MAX,
    ) {
        let address = |key: &[u8; 33], seq: u32| {
            let (head, tail) = key_seeds(key);
            Pubkey::find_program_address(&[LOCK_SEED, head, tail, &seq.to_le_bytes()], &buckspay::ID).0
        };
        prop_assume!((a, sa) != (b, sb));
        prop_assert_ne!(address(&a, sa), address(&b, sb));
    }

    #[test]
    fn a_keys_accounts_of_different_types_never_collide(key in key33(), seq in 0u32..u32::MAX) {
        let (head, tail) = key_seeds(&key);
        let find = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &buckspay::ID).0;
        let lock = find(&[LOCK_SEED, head, tail, &seq.to_le_bytes()]);
        let all = [
            find(&[DEVICE_SEED, head, tail]),
            find(&[ROTATION_SEED, head, tail]),
            lock,
            find(&[LEDGER_SEED, lock.as_ref()]),
            find(&[ESCROW_SEED, lock.as_ref()]),
        ];
        for i in 0..all.len() {
            for j in i + 1..all.len() {
                prop_assert_ne!(all[i], all[j]);
            }
        }
    }
}
