//! `claim_rewards` on the built binary, on the feature set of each live cluster. The proofs are
//! recorded fixtures made under the claim test keys.
mod common;
use buckspay_zk_verify::{fr, vk};
use common::channel::rewards::{Proving, Which};
use common::channel::*;
use common::poseidon::{hash, poseidon2};
use solana_signer::Signer;

fn spent(env: &ChannelEnv, wallet: &common::channel::rewards::Wallet) -> u64 {
    env.wallet_balance(wallet)
}

#[test]
fn a_claim_lands_in_a_fresh_wallet_and_the_same_nullifier_fails_again() {
    each_cluster(|env| {
        let leaf = env.settled_leaf(3);
        let fresh = env.fresh_wallet_with_zero_sol();
        let claim = env.claim_one(&leaf, &fresh, env.claim_fee());
        env.claim(&claim).unwrap();
        assert_eq!(spent(env, &fresh), 8 * env.unit() - env.claim_fee());
        assert_eq!(env.env.lamports(&fresh.owner), 0);
        assert!(env.nullifier_exists(&leaf));
        let other = env.fresh_wallet_with_zero_sol();
        let replay = claim.clone().recipient_wallet(&other);
        let refused = env.claim(&replay).unwrap_err();
        assert_eq!(refused.code(), env.error("NullifierReused"));
        assert_eq!(spent(env, &other), 0);
    });
}

#[test]
fn several_claims_verify_in_one_transaction_for_one_recipient() {
    each_cluster(|env| {
        let leaves = [
            env.settled_leaf(1),
            env.settled_leaf(1),
            env.settled_leaf(2),
            env.settled_leaf(1),
        ];
        let fresh = env.fresh_wallet_with_zero_sol();
        let fees = env.fee_account_balance();
        env.claim(&env.claim_many(&leaves, &fresh, env.claim_fee()))
            .unwrap();
        assert_eq!(
            spent(env, &fresh),
            (2 + 2 + 4 + 2) * env.unit() - 4 * env.claim_fee()
        );
        assert_eq!(env.fee_account_balance() - fees, 4 * env.claim_fee());
    });
}

#[test]
fn duplicate_nullifiers_in_one_transaction_are_refused_before_verification() {
    each_cluster(|env| {
        let leaf = env.settled_leaf(1);
        let fresh = env.fresh_wallet_with_zero_sol();
        let mut claim = env.claim_many(&[leaf.clone(), leaf], &fresh, env.claim_fee());
        claim.claims[1].proof[17] ^= 1;
        let refused = env.claim(&claim).unwrap_err();
        assert_eq!(refused.code(), env.error("NullifierReused"));
    });
}

#[test]
fn every_public_alteration_is_rejected_and_nothing_is_paid() {
    each_cluster(|env| {
        env.settled_leaf(1);
        let leaf = env.settled_leaf(2);
        let fresh = env.fresh_wallet_with_zero_sol();
        let stranger = env.fresh_wallet_with_zero_sol();
        let known = env.other_known_root(leaf.epoch);
        type Alter = Box<dyn Fn(&mut common::channel::rewards::Claim)>;
        let cases: Vec<(&str, Alter)> = vec![
            (
                "recipient",
                Box::new(move |c| *c = c.clone().recipient_wallet(&stranger)),
            ),
            ("exp", Box::new(|c| c.claims[0].exp = 3)),
            (
                "nullifier",
                Box::new(|c| c.claims[0].nullifier_hash[31] ^= 1),
            ),
            ("max_fee", Box::new(|c| c.max_fee += 1)),
            ("proof", Box::new(|c| c.claims[0].proof[17] ^= 1)),
            ("root", Box::new(move |c| c.claims[0].root = known)),
        ];
        let pool = env.pool_balance();
        for (name, alter) in cases {
            let mut claim = env.claim_one(&leaf, &fresh, env.claim_fee());
            alter(&mut claim);
            let refused = env.claim(&claim).unwrap_err();
            assert_eq!(
                refused.code(),
                env.error("ClaimRejected"),
                "{name} accepted"
            );
        }
        assert_eq!(env.pool_balance(), pool);
        assert_eq!(spent(env, &fresh), 0);
        assert!(!env.nullifier_exists(&leaf));
        env.claim(&env.claim_one(&leaf, &fresh, env.claim_fee()))
            .expect("the unaltered claim is accepted");
    });
}

#[test]
fn a_proof_for_another_mint_or_cluster_scope_is_rejected() {
    each_cluster(|env| {
        let leaf = env.settled_leaf(1);
        let fresh = env.fresh_wallet_with_zero_sol();
        let foreign = fr::reduce(&hash(&[&[7u8; 32], &[9u8; 32]]));
        let proving = Proving {
            scope: Some(foreign),
            ..Proving::CURRENT
        };
        let claim = env.claim_of(
            std::slice::from_ref(&leaf),
            &fresh,
            env.claim_fee(),
            proving,
        );
        let refused = env.claim(&claim).unwrap_err();
        assert_eq!(refused.code(), env.error("ClaimRejected"));
        assert_eq!(spent(env, &fresh), 0);
        env.claim(&env.claim_one(&leaf, &fresh, env.claim_fee()))
            .expect("the same leaf under the program's scope is accepted");
    });
}

#[test]
fn unknown_or_expired_root_is_refused() {
    each_cluster(|env| {
        let leaf = env.settled_leaf(1);
        let fresh = env.fresh_wallet_with_zero_sol();
        let old = env.claim_one(&leaf, &fresh, env.claim_fee());
        env.settle_dummy_batches(256);
        let refused = env.claim(&old).unwrap_err();
        assert_eq!(refused.code(), env.error("UnknownRoot"));
        let again = env.claim_one(&leaf, &fresh, env.claim_fee());
        env.claim(&again).unwrap();
        assert_eq!(spent(env, &fresh), 2 * env.unit() - env.claim_fee());
    });
}

#[test]
fn fee_above_the_proved_maximum_is_refused() {
    each_cluster(|env| {
        let leaf = env.settled_leaf(1);
        env.set_claim_policy(env.claim_fee() + 1, env.policy().claim_cap);
        let fresh = env.fresh_wallet_with_zero_sol();
        let claim = env.claim_one(&leaf, &fresh, env.claim_fee() - 1);
        let refused = env.claim(&claim).unwrap_err();
        assert_eq!(refused.code(), env.error("FeeAboveMax"));
    });
}

#[test]
fn claim_cap_bounds_payouts_per_window() {
    each_cluster(|env| {
        env.set_claim_policy(env.claim_fee(), 10 * env.unit());
        let leaves = [env.settled_leaf(3), env.settled_leaf(2)];
        let fresh = env.fresh_wallet_with_zero_sol();
        env.claim(&env.claim_one(&leaves[0], &fresh, env.claim_fee()))
            .unwrap();
        let second = env.claim_one(&leaves[1], &fresh, env.claim_fee());
        let refused = env.claim(&second).unwrap_err();
        assert_eq!(refused.code(), env.error("ClaimCapExceeded"));
        let later = i64::from(env.env.now()) + 2 * 86_400;
        env.env.warp(later);
        env.claim(&second).unwrap();
    });
}

#[test]
fn paused_refuses_before_verification_and_only_the_admin_unpauses() {
    each_cluster(|env| {
        let leaf = env.settled_leaf(1);
        let fresh = env.fresh_wallet_with_zero_sol();
        let (pauser, admin) = (env.pauser.insecure_clone(), env.admin.insecure_clone());
        let mut claim = env.claim_one(&leaf, &fresh, env.claim_fee());
        let pause = env.admin_ix(&pauser.pubkey(), true);
        env.env.send(&pauser, &[pause]).unwrap();
        claim.claims[0].proof[17] ^= 1;
        let refused = env.claim(&claim).unwrap_err();
        assert_eq!(refused.code(), env.error("RewardsPaused"));
        let unpause = env.admin_ix(&pauser.pubkey(), false);
        assert!(env.env.send(&pauser, &[unpause]).is_err());
        let unpause = env.admin_ix(&admin.pubkey(), false);
        env.env.send(&admin, &[unpause]).unwrap();
        claim.claims[0].proof[17] ^= 1;
        env.claim(&claim).unwrap();
    });
}

#[test]
fn stale_claim_key_is_refused_and_the_previous_key_works_inside_its_window() {
    each_cluster(|env| {
        env.before_claim_key_rotation();
        let leaves = [env.settled_leaf(1), env.settled_leaf(1)];
        let (a, b) = (
            env.fresh_wallet_with_zero_sol(),
            env.fresh_wallet_with_zero_sol(),
        );
        let previous = Proving {
            which: Which::Previous,
            ..Proving::CURRENT
        };
        let proved = |env: &ChannelEnv, leaf: &common::channel::rewards::Leaf, w| {
            env.claim_of(std::slice::from_ref(leaf), w, env.claim_fee(), previous)
        };
        let (old, late) = (proved(env, &leaves[0], &a), proved(env, &leaves[1], &b));
        let current = env.claim_one(&leaves[0], &a, env.claim_fee());
        assert_eq!(
            env.claim(&current).unwrap_err().code(),
            env.error("StaleClaimKey"),
            "the config still holds the previous key as current"
        );
        assert_eq!(
            env.claim(&old).unwrap_err().code(),
            env.error("StaleClaimKey"),
            "the previous key is not accepted before a rotation records it"
        );
        let admin = env.admin.insecure_clone();
        let rotated_at = env.rotate_claim_vk(&admin, true).unwrap();
        env.claim(&old).unwrap();
        env.env
            .warp(rotated_at + buckspay::CLAIM_KEY_OVERLAP_SECS + i64::from(env.grace()) + 1);
        assert_eq!(
            env.claim(&late).unwrap_err().code(),
            env.error("StaleClaimKey")
        );
        assert_eq!(env.wallet_balance(&b), 0);
    });
}

#[test]
fn claim_key_rotation_belongs_to_the_admin_and_revocation_to_the_pauser_too() {
    each_cluster(|env| {
        let (admin, pauser, stranger) = (
            env.admin.insecure_clone(),
            env.pauser.insecure_clone(),
            env.stranger.insecure_clone(),
        );
        assert!(
            env.rotate_claim_vk(&admin, true).is_err(),
            "no previous key is carried yet"
        );
        env.before_claim_key_rotation();
        assert!(env.rotate_claim_vk(&stranger, true).is_err());
        assert!(env.rotate_claim_vk(&pauser, true).is_err());
        env.rotate_claim_vk(&admin, true).unwrap();
        assert_ne!(env.reward_config().rotated_at, 0);
        assert!(env.revoke_previous_claim_vk(&stranger).is_err());
        env.revoke_previous_claim_vk(&pauser).unwrap();
        assert_eq!(env.reward_config().rotated_at, 0);
        env.before_claim_key_rotation();
        env.rotate_claim_vk(&admin, false).unwrap();
        assert_eq!(env.reward_config().rotated_at, 0);
        assert_eq!(env.reward_config().claim_key.vk, *vk::CLAIM.sha256);
    });
}

#[test]
fn the_pool_pays_only_from_its_own_ledger_and_never_reaches_a_lock() {
    each_cluster(|env| {
        let leaf = env.settled_leaf(2);
        let locks = env.lock_accounts_digest();
        let fresh = env.fresh_wallet_with_zero_sol();
        env.claim(&env.claim_one(&leaf, &fresh, env.claim_fee()))
            .unwrap();
        assert_eq!(env.lock_accounts_digest(), locks);
        assert!(env.pool_is_solvent());
    });
}

#[test]
fn a_leaf_built_with_a_wrong_exp_cannot_be_claimed() {
    each_cluster(|env| {
        let leaf = env.settled_leaf(1);
        assert_eq!(
            env.tree_leaf(leaf.epoch, leaf.index),
            poseidon2(&leaf.inner(), 1)
        );
        let fresh = env.fresh_wallet_with_zero_sol();
        let forged = env.claim_forged(&leaf, 7, &fresh, env.claim_fee());
        let refused = env.claim(&forged).unwrap_err();
        assert_eq!(refused.code(), env.error("UnknownRoot"));
        let mut relabelled = env.claim_one(&leaf, &fresh, env.claim_fee());
        relabelled.claims[0].exp = 7;
        let refused = env.claim(&relabelled).unwrap_err();
        assert_eq!(refused.code(), env.error("ClaimRejected"));
        assert!(!env.nullifier_exists(&leaf));
    });
}

#[test]
fn noncanonical_nullifier_hash_is_refused() {
    each_cluster(|env| {
        let leaf = env.settled_leaf(1);
        let fresh = env.fresh_wallet_with_zero_sol();
        let mut claim = env.claim_one(&leaf, &fresh, env.claim_fee());
        let mut alias = claim.claims[0].nullifier_hash;
        let mut carry = 0u16;
        for (byte, modulus) in alias.iter_mut().zip(fr::MODULUS).rev() {
            let sum = u16::from(*byte) + u16::from(modulus) + carry;
            *byte = sum as u8;
            carry = sum >> 8;
        }
        assert_eq!(carry, 0);
        let honest = claim.clone();
        claim.claims[0].nullifier_hash = alias;
        let refused = env.claim(&claim).unwrap_err();
        assert_eq!(refused.code(), env.error("NonCanonicalNullifier"));
        env.claim(&honest).unwrap();
    });
}

#[test]
fn a_claim_names_its_own_tree_and_its_own_accounts() {
    each_cluster(|env| {
        let leaf = env.settled_leaf(1);
        let fresh = env.fresh_wallet_with_zero_sol();
        let claim = env.claim_one(&leaf, &fresh, env.claim_fee());
        let honest = env.claim_ix(&claim);
        let tree_at = honest.accounts.len() - 2;
        let mut wrong_tree = honest.clone();
        wrong_tree.accounts[tree_at].pubkey = env.pool_ledger;
        let mut wrong_nullifier = honest.clone();
        wrong_nullifier.accounts[tree_at + 1].pubkey = env.fee_account;
        let mut missing = honest.clone();
        missing.accounts.truncate(tree_at);
        let mut to_pool = honest.clone();
        to_pool.accounts[6].pubkey = env.pool_escrow;
        let duplicate = anchor_lang::error::ErrorCode::ConstraintDuplicateMutableAccount as u32;
        for (ix, name) in [
            (wrong_tree, "WrongRewardTree"),
            (wrong_nullifier, "WrongNullifierAccount"),
            (missing, "ClaimCount"),
        ] {
            let refused = env.env.send_v1(&[ix]).unwrap_err();
            assert_eq!(
                common::channel::Refused(refused).code(),
                env.error(name),
                "{name}"
            );
        }
        let mut too_many = claim.clone();
        too_many.claims = vec![claim.claims[0].clone(); buckspay::MAX_CLAIMS_PER_TX + 1];
        let refused = env.claim(&too_many).unwrap_err();
        assert_eq!(
            refused.code(),
            env.error("ClaimCount"),
            "one claim above the limit"
        );
        let refused = env.env.send_v1(&[to_pool]).unwrap_err();
        assert_eq!(
            common::channel::Refused(refused).code(),
            duplicate,
            "the pool as recipient"
        );
        env.claim(&claim).unwrap();
    });
}

#[test]
fn one_root_per_settle_transaction() {
    each_cluster(|env| {
        let before = env.roots_pushed();
        env.settle_words(14);
        assert_eq!(env.roots_pushed(), before + 1);
        assert_eq!(env.tree_next_index(), 3);
    });
}

#[test]
fn a_full_tree_refuses_appends_until_rotated_and_old_epochs_stay_claimable() {
    each_cluster(|env| {
        let old = env.settled_leaf(2);
        let wallet = env.fresh_wallet_with_zero_sol();
        let claim = env.claim_one(&old, &wallet, env.claim_fee());
        env.set_tree_next_index((1 << 20) - 2);
        assert_eq!(env.settle_words_err(14).code(), env.error("TreeFull"));
        env.rotate().unwrap();
        assert_eq!(env.rotate().unwrap_err().code(), env.error("TreeNotFull"));
        env.settle_words(14);
        assert_eq!(env.current_epoch(), 1);
        env.claim(&claim).unwrap();
        assert_eq!(spent(env, &wallet), 4 * env.unit() - env.claim_fee());
    });
}

#[test]
fn leaf_vectors_match_go_on_the_live_feature_sets() {
    each_cluster(|env| {
        for v in common::channel::rewards::go_derivations() {
            if !(1..=7).contains(&v.exp) {
                continue;
            }
            assert_eq!(
                buckspay::rewards::tree::leaf(&v.inner, v.exp).unwrap(),
                v.leaf
            );
            // A batch of more than eight words does not fit a transaction with its proofs.
            if v.exp <= 3 {
                let (epoch, index) = env.settle_inner(v.exp, v.inner);
                assert_eq!(env.tree_leaf(epoch, index), v.leaf, "exp {}", v.exp);
            }
        }
    });
}

#[test]
fn claimed_totals_are_conserved_across_batch_shapes() {
    each_cluster(|env| {
        for exps in [vec![1u8], vec![2, 3], vec![1, 2, 3], vec![3, 1, 2, 1]] {
            let leaves: Vec<_> = exps.iter().map(|e| env.settled_leaf(*e)).collect();
            let fresh = env.fresh_wallet_with_zero_sol();
            let (pool, fees) = (env.pool_balance(), env.fee_account_balance());
            let claim = env.claim_many(&leaves, &fresh, env.claim_fee());
            env.claim(&claim).unwrap();
            let gross: u64 = exps.iter().map(|e| env.unit() << e).sum();
            assert_eq!(pool - env.pool_balance(), gross);
            assert_eq!(
                spent(env, &fresh) + (env.fee_account_balance() - fees),
                gross
            );
            for leaf in &leaves {
                assert!(env.nullifier_exists(leaf));
            }
            assert!(env.claim(&claim).is_err());
            assert!(env.pool_is_solvent());
        }
    });
}

#[test]
fn an_empty_ring_slot_or_an_exponent_no_batch_can_have_is_refused() {
    each_cluster(|env| {
        let leaf = env.settled_leaf(1);
        let fresh = env.fresh_wallet_with_zero_sol();
        let honest = env.claim_one(&leaf, &fresh, env.claim_fee());
        let mut empty = honest.clone();
        empty.claims[0].root = [0u8; 32];
        let refused = env.claim(&empty).unwrap_err();
        assert_eq!(refused.code(), env.error("UnknownRoot"));
        for exp in [0u8, 8, 255] {
            let mut claim = honest.clone();
            claim.claims[0].exp = exp;
            let refused = env.claim(&claim).unwrap_err();
            assert_eq!(refused.code(), env.error("BadDenomination"), "exp {exp}");
        }
        env.claim(&honest).unwrap();
    });
}

#[test]
fn a_tree_must_be_the_account_of_its_own_mint_epoch_and_address() {
    each_cluster(|env| {
        let leaf = env.settled_leaf(1);
        let fresh = env.fresh_wallet_with_zero_sol();
        let claim = env.claim_one(&leaf, &fresh, env.claim_fee());
        let honest = env.claim_ix(&claim);
        let tree_at = honest.accounts.len() - 2;
        let real = env.env.svm.get_account(&env.tree).unwrap();

        let copy = anchor_lang::prelude::Pubkey::new_unique();
        env.env.set_account(copy, real.clone());
        let mut elsewhere = honest.clone();
        elsewhere.accounts[tree_at].pubkey = copy;
        let refused = env.env.send_v1(&[elsewhere]).unwrap_err();
        assert_eq!(
            common::channel::Refused(refused).code(),
            env.error("WrongRewardTree"),
            "a copy of the tree at another address"
        );

        let mut relabelled = real;
        relabelled.data[40..44].copy_from_slice(&1u32.to_le_bytes());
        env.env.set_account(env.tree, relabelled);
        let refused = env.env.send_v1(&[honest]).unwrap_err();
        assert_eq!(
            common::channel::Refused(refused).code(),
            env.error("WrongRewardTree"),
            "a tree that names another epoch"
        );
    });
}
