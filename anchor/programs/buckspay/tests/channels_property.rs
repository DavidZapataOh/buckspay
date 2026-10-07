//! The invariants of the delivery-word channel as properties: a word settles once, what a lock
//! pays equals what the pool and the fee account receive, the leaves carry exactly what the pool
//! was credited, the tree follows a reference, and a channel never closes while a word could
//! still settle.
mod common;
use anchor_lang::prelude::Pubkey;
use buckspay::{
    channel::{check_commitment, closable_at, Channel, BITMAP_LEN},
    rewards::{tree, RewardTree, ROOT_HISTORY},
    state::Ledger,
    BuckspayError,
};
use buckspay_protocol::{
    payword::{canonical_exps, MAX_WORDS_PER_TX},
    window::{self, Settle},
};
use common::channel::tree_root;
use proptest::prelude::*;
use std::collections::HashSet;

fn empty_channel(depth: u8) -> Channel {
    Channel {
        lock: Pubkey::default(),
        commitment_hash: [0; 32],
        root: [0; 32],
        depth,
        word_value: 1,
        cum_end: 0,
        expiry: 0,
        settled: [0; BITMAP_LEN],
        payer: Pubkey::default(),
        closable_at: 0,
        bump: 0,
    }
}

fn leaf_of(n: u32) -> [u8; 32] {
    let mut leaf = [0u8; 32];
    leaf[28..].copy_from_slice(&(n + 1).to_be_bytes());
    leaf
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn a_word_settles_once_and_the_bitmap_follows_a_set(
        depth in 4u8..=8,
        attempts in proptest::collection::vec(0u16..300, 1..120),
    ) {
        let mut channel = empty_channel(depth);
        let mut model = HashSet::new();
        for index in attempts {
            let fresh = u32::from(index) < 1 << depth && model.insert(index);
            prop_assert_eq!(channel.settle_word(index).is_ok(), fresh);
            for i in 0..(1u16 << depth) {
                prop_assert_eq!(channel.is_settled(i), model.contains(&i));
            }
        }
    }

    #[test]
    fn a_lock_pays_exactly_what_the_pool_and_the_fee_account_receive(
        backing in 0u64..10_000_000,
        word_fee in 1u64..50_000,
        unit in 1u64..500_000,
        batches in proptest::collection::vec(1u64..=64, 1..12),
    ) {
        let mut lock = Ledger::new(0, backing, Pubkey::default(), [2; 33], 0, 0);
        let mut pool = Ledger::new(0, 0, Pubkey::default(), {
            let mut key = [0u8; 33];
            key[0] = buckspay::REWARD_LEDGER_MARKER;
            key
        }, 0, 0);
        let (mut paid, mut credited, mut fees) = (0u64, 0u64, 0u64);
        for n in batches {
            let (fee, share) = (n * word_fee, n * unit);
            let before = lock.backing_left;
            let drawn = lock.pay_backing(fee).and_then(|_| lock.pay_backing(share));
            match drawn {
                Ok(_) => {
                    pool.credit_reward(share).unwrap();
                    paid += fee + share;
                    credited += share;
                    fees += fee;
                }
                Err(_) => {
                    // a refused batch is atomic on the transaction, so the half it drew is undone
                    lock.backing_left = before;
                }
            }
            prop_assert_eq!(lock.backing_left, backing - paid);
            prop_assert_eq!(pool.backing_left, credited);
            prop_assert_eq!(paid, credited + fees);
        }
    }

    #[test]
    fn the_leaves_of_a_batch_carry_exactly_what_the_pool_was_credited(
        half in 1u32..=(MAX_WORDS_PER_TX / 2),
        unit in 1u64..1_000_000,
    ) {
        let words = half * 2;
        let exps = canonical_exps(words).unwrap();
        let carried: u128 = exps.iter().map(|e| u128::from(unit) << e).sum();
        prop_assert_eq!(carried, u128::from(unit) * u128::from(words));
    }

    #[test]
    fn a_commitment_is_accepted_exactly_when_a_quarter_of_the_bond_covers_it(
        depth in 0u8..12,
        word_value in 1u64..10_000_000,
        bond in 0u64..2_000_000_000,
        backing in 0u64..2_000_000_000,
        cum_end in 0u64..2_000_000_000,
    ) {
        let verdict = check_commitment(depth, word_value, cum_end, bond, backing);
        let total = u128::from(word_value) << depth.min(63);
        let accepted = (4..=8).contains(&depth)
            && total <= u128::from(bond / 4)
            && cum_end <= backing
            && u128::from(cum_end) >= total;
        prop_assert_eq!(verdict.is_ok(), accepted);
    }

    #[test]
    fn a_channel_never_closes_while_a_word_could_still_settle(
        expiry in 1_700_000_000u32..2_100_000_000,
        lock_span in 1u32..40_000_000,
        offset in 0u64..90_000_000,
    ) {
        let lock_until = expiry.saturating_add(lock_span).saturating_sub(lock_span / 2);
        if let Ok(close) = closable_at(expiry, lock_until) {
            let now = u32::try_from(u64::from(expiry) + offset).unwrap_or(u32::MAX);
            if window::settle(expiry, lock_until, now) == Settle::Open {
                prop_assert!(now < close);
            }
        }
    }

    #[test]
    fn the_tree_follows_a_reference_and_remembers_exactly_its_recent_roots(
        sizes in proptest::collection::vec(1usize..=7, 1..24),
    ) {
        let mut state: RewardTree = anchor_lang::__private::bytemuck::Zeroable::zeroed();
        let mut leaves: Vec<[u8; 32]> = vec![];
        let mut roots: Vec<[u8; 32]> = vec![];
        for size in sizes {
            let batch: Vec<[u8; 32]> = (0..size).map(|k| leaf_of((leaves.len() + k) as u32)).collect();
            let first = tree::append_batch(&mut state, &batch).unwrap();
            prop_assert_eq!(first as usize, leaves.len());
            leaves.extend(batch);
            roots.push(tree_root(&leaves));
            prop_assert_eq!(state.next_index as usize, leaves.len());
            prop_assert_eq!(state.roots[(state.root_index as usize - 1) % ROOT_HISTORY], *roots.last().unwrap());
        }
        for root in &roots {
            prop_assert!(tree::known_root(&state, root));
        }
        prop_assert!(!tree::known_root(&state, &[0; 32]));
        prop_assert!(!tree::known_root(&state, &leaf_of(u32::MAX - 1)));
    }
}

#[test]
fn a_ring_of_roots_forgets_the_oldest_after_256_transactions() {
    let mut state: RewardTree = anchor_lang::__private::bytemuck::Zeroable::zeroed();
    let mut roots = vec![];
    for k in 0..ROOT_HISTORY as u32 + 3 {
        tree::append_batch(&mut state, &[leaf_of(k)]).unwrap();
        roots.push(state.roots[(state.root_index as usize - 1) % ROOT_HISTORY]);
    }
    assert!(!tree::known_root(&state, &roots[0]));
    assert!(!tree::known_root(&state, &roots[2]));
    assert!(tree::known_root(&state, &roots[3]));
    assert!(tree::known_root(&state, roots.last().unwrap()));
}

#[test]
fn the_unfilled_ring_matches_no_root_and_a_full_tree_refuses() {
    let mut state: RewardTree = anchor_lang::__private::bytemuck::Zeroable::zeroed();
    assert!(!tree::known_root(&state, &[0; 32]));
    state.next_index = (1 << 20) - 7;
    tree::append_batch(&mut state, &[leaf_of(1); 7]).unwrap();
    let full = tree::append_batch(&mut state, &[leaf_of(2)]).unwrap_err();
    assert_eq!(
        full,
        anchor_lang::error::Error::from(BuckspayError::TreeFull)
    );
}

#[test]
fn the_zero_hashes_are_the_poseidon_chain_of_the_empty_tree() {
    let mut zero = [0u8; 32];
    for level in 0..buckspay::rewards::TREE_DEPTH {
        assert_eq!(buckspay::rewards::ZEROS[level], zero, "level {level}");
        zero = common::channel::hash_pair(&zero, &zero);
    }
    assert_eq!(tree_root(&[]), zero);
}
