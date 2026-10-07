//! The reward pool's configuration and its tree of epochs, on the built binary and on the feature
//! set of each live cluster.
mod common;
use anchor_lang::solana_program::instruction::Instruction;
use common::channel::*;
use common::zk::Cluster;
use common::{Keypair, Landed};
use solana_signer::Signer;

fn send_as(env: &mut ChannelEnv, signer: &Keypair, ix: Instruction) -> Result<Landed, Refused> {
    env.env.send(signer, &[ix]).map_err(Refused)
}

#[test]
fn a_mint_is_configured_once_by_the_admin_with_fees_that_fit_a_word() {
    for cluster in [Cluster::Devnet, Cluster::Mainnet] {
        let mut env = ChannelEnv::bare(cluster);
        let (admin, stranger) = (env.admin.insecure_clone(), env.stranger.insecure_clone());
        let good = env.policy();
        let bad = [
            buckspay::RewardPolicy {
                word_fee: 0,
                ..good
            },
            buckspay::RewardPolicy {
                word_fee: good.word_value,
                ..good
            },
            buckspay::RewardPolicy {
                max_fee: 2 * (good.word_value - good.word_fee),
                ..good
            },
            buckspay::RewardPolicy {
                claim_fee: good.max_fee + 1,
                ..good
            },
            buckspay::RewardPolicy {
                claim_fee: good.word_value - good.word_fee,
                max_fee: good.max_fee,
                ..good
            },
        ];
        for policy in bad {
            let ix = env.init_mint_ix(&admin.pubkey(), policy);
            let refused = send_as(&mut env, &admin, ix).unwrap_err();
            assert_eq!(refused.code(), env.error("FeeAboveValue"), "{policy:?}");
        }
        let ix = env.init_mint_ix(&stranger.pubkey(), good);
        let refused = send_as(&mut env, &stranger, ix).unwrap_err();
        assert_eq!(refused.code(), env.error("NotRewardAdmin"));
        let ix = env.init_mint_ix(&admin.pubkey(), good);
        send_as(&mut env, &admin, ix).unwrap();
        let ix = env.init_mint_ix(&admin.pubkey(), good);
        assert!(send_as(&mut env, &admin, ix).is_err(), "configured twice");
        let mint = env.reward_mint_account();
        assert_eq!(mint.unit, good.word_value - good.word_fee);
        assert_eq!(mint.epoch, 0);
        let ledger = env.env.ledger(&env.reward_mint);
        assert_eq!(ledger.key[0], buckspay::REWARD_LEDGER_MARKER);
        assert_eq!(ledger.backing_left, 0);
    }
}

#[test]
fn only_the_claim_side_of_the_policy_can_change_and_only_by_the_admin() {
    each_cluster(|env| {
        let (admin, stranger) = (env.admin.insecure_clone(), env.stranger.insecure_clone());
        let before = env.reward_mint_account();
        let ix = env.set_policy_ix(&stranger.pubkey(), 1, env.fee_account, 1);
        assert_eq!(
            send_as(env, &stranger, ix).unwrap_err().code(),
            env.error("NotRewardAdmin")
        );
        let ix = env.set_policy_ix(&admin.pubkey(), before.max_fee + 1, env.fee_account, 1);
        assert_eq!(
            send_as(env, &admin, ix).unwrap_err().code(),
            env.error("FeeAboveValue")
        );
        let ix = env.set_policy_ix(&admin.pubkey(), 300_000, env.fee_account, 7);
        send_as(env, &admin, ix).unwrap();
        let after = env.reward_mint_account();
        assert_eq!((after.claim_fee, after.claim_cap), (300_000, 7));
        assert_eq!(
            (after.word_value, after.word_fee, after.unit, after.max_fee),
            (
                before.word_value,
                before.word_fee,
                before.unit,
                before.max_fee
            )
        );
    });
}

#[test]
fn the_pauser_can_only_pause_and_a_stranger_cannot_do_either() {
    each_cluster(|env| {
        let (admin, pauser, stranger) = (
            env.admin.insecure_clone(),
            env.pauser.insecure_clone(),
            env.stranger.insecure_clone(),
        );
        let ix = env.admin_ix(&stranger.pubkey(), true);
        assert!(send_as(env, &stranger, ix).is_err());
        let ix = env.admin_ix(&pauser.pubkey(), true);
        send_as(env, &pauser, ix).unwrap();
        let ix = env.admin_ix(&pauser.pubkey(), false);
        assert!(send_as(env, &pauser, ix).is_err());
        let ix = env.admin_ix(&admin.pubkey(), false);
        send_as(env, &admin, ix).unwrap();
    });
}

#[test]
fn a_full_tree_refuses_words_until_anyone_rotates_to_the_next_epoch() {
    each_cluster(|env| {
        let a = env.payer_channel(4);
        let first = env.send(Settle::new().first(&a, &[0, 1]).inners_for(2));
        first.unwrap();
        let old_root = env.latest_root();
        assert_eq!(env.rotate().unwrap_err().code(), env.error("TreeNotFull"));
        env.set_tree_next_index((1 << 20) - 7);
        env.send(Settle::new().again(&a, &[2, 3]).inners_for(2))
            .unwrap();
        env.set_tree_next_index((1 << 20) - 6);
        env.refuses(Settle::new().again(&a, &[4, 5]).inners_for(2), "TreeFull");
        env.rotate().unwrap();
        assert_eq!(env.reward_mint_account().epoch, 1);
        env.send(Settle::new().again(&a, &[4, 5]).inners_for(2))
            .unwrap();
        assert_eq!(env.tree_next_index(), 1);
        let old = read_tree(&env.env, &reward_tree_address(&env.env.mint, 0));
        assert!(buckspay::rewards::tree::known_root(&old, &old_root));
        assert_eq!(
            old.next_index,
            (1 << 20) - 6,
            "an old epoch takes no more appends"
        );
        assert!(env.rotate().is_err(), "the new tree is empty");
    });
}
