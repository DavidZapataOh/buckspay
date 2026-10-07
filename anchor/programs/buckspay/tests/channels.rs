//! `settle_channel` and `close_channel` on the built binary, on the feature set of each live
//! cluster. Every batch has an even word count because the smallest leaf holds two words.
mod common;
use buckspay_protocol::slash;
use common::channel::*;
use common::poseidon::poseidon2;

type Alteration = Box<dyn Fn(&mut Settle)>;

#[test]
fn a_relayer_settles_words_of_two_payers_once_into_the_pool() {
    each_cluster(|env| {
        let a = env.payer_channel(4);
        let b = env.payer_channel(4);
        let pool_before = env.pool_balance();
        env.send(
            Settle::new()
                .first(&a, &[0, 1, 2])
                .first(&b, &[0, 1, 2])
                .inners_for(6),
        )
        .unwrap();
        assert_eq!(env.pool_balance() - pool_before, 6 * env.unit());
        assert_eq!(env.fee_account_delta(), 6 * env.word_fee());
        assert_eq!(env.lock_backing_drawn(&a), 3 * env.word_value());
        assert_eq!(env.tree_next_index(), 2);
        assert_eq!(env.roots_pushed(), 1);
        assert!(env.bits_set(&a, &[0, 1, 2]) && env.bits_set(&b, &[0, 1, 2]));
        assert_eq!(env.latest_root(), tree_root(&env.leaves));
    });
}

#[test]
fn the_program_computes_each_leaf_from_the_inner_and_its_own_exponent() {
    each_cluster(|env| {
        let a = env.payer_channel(4);
        let tx = Settle::new().first(&a, &[0, 1, 2, 3, 4, 5]).inners_for(6);
        let inners = tx.inners.clone();
        env.send(tx).unwrap();
        assert_eq!(env.leaf_at(0), poseidon2(&inners[0], 2));
        assert_eq!(env.leaf_at(1), poseidon2(&inners[1], 1));
        assert_ne!(env.leaf_at(1), poseidon2(&inners[1], 2));
        assert_eq!(env.leaf_events(), vec![(0, 2), (1, 1)]);
    });
}

#[test]
fn two_batches_append_in_order_and_the_root_follows_the_host_twin() {
    each_cluster(|env| {
        let a = env.payer_channel(4);
        env.send(Settle::new().first(&a, &[0, 1]).inners_for(2))
            .unwrap();
        env.send(Settle::new().again(&a, &[2, 3, 4, 5, 6, 7]).inners_for(6))
            .unwrap();
        assert_eq!(env.tree_next_index(), 3);
        assert_eq!(env.roots_pushed(), 2);
        assert_eq!(env.latest_root(), tree_root(&env.leaves));
    });
}

#[test]
fn inner_count_and_values_must_match_the_canonical_decomposition() {
    each_cluster(|env| {
        let a = env.payer_channel(4);
        let words = [0, 1, 2, 3, 4, 5];
        env.refuses(
            Settle::new().first(&a, &words).inners(3),
            "InnersDoNotMatchWords",
        );
        env.refuses(
            Settle::new().first(&a, &words).inners(1),
            "InnersDoNotMatchWords",
        );
        env.refuses(
            Settle::new().first(&a, &[0, 1, 2]).inners(2),
            "InnersDoNotMatchWords",
        );
        env.refuses(
            Settle::new().first(&a, &words).inners_with(&[R, [1; 32]]),
            "NonCanonicalInner",
        );
        env.assert_no_writes();
        env.send(
            Settle::new()
                .first(&a, &words)
                .inners_with(&[R_MINUS_1, [0; 32]]),
        )
        .unwrap();
    });
}

#[test]
fn later_batches_verify_against_the_stored_root() {
    each_cluster(|env| {
        let a = env.payer_channel(4);
        let twin = env.channel_same_lock_other_seed(&a);
        env.send(Settle::new().first(&a, &[0, 1]).inners_for(2))
            .unwrap();
        assert_eq!(env.channel_root(&a), a.root);
        let forged = Settle::new()
            .again(&a, &[])
            .with_word_of(&twin, 2)
            .with_word_of(&twin, 3)
            .inners_for(2);
        assert_eq!(
            env.send(forged).unwrap_err().code(),
            env.error("WordRejected")
        );
        env.send(Settle::new().again(&a, &[2, 3]).inners_for(2))
            .unwrap();
    });
}

#[test]
fn a_settled_word_cannot_be_settled_again_in_any_transaction() {
    each_cluster(|env| {
        let a = env.payer_channel(4);
        env.send(Settle::new().first(&a, &[4, 5]).inners_for(2))
            .unwrap();
        env.refuses(
            Settle::new().again(&a, &[4, 6]).inners_for(2),
            "WordAlreadySettled",
        );
        env.refuses(
            Settle::new().again(&a, &[7, 7]).inners_for(2),
            "WordAlreadySettled",
        );
        env.assert_unchanged_since_last_success();
    });
}

#[test]
fn every_word_alteration_is_refused_without_writes() {
    each_cluster(|env| {
        let a = env.payer_channel(4);
        let other = env.payer_channel(4);
        let cases: Vec<(&str, Alteration)> = vec![
            (
                "path",
                Box::new(|s| s.channels[0].args.words[0].path[0][0] ^= 1),
            ),
            (
                "word",
                Box::new(|s| s.channels[0].args.words[0].word[3] ^= 1),
            ),
            (
                "index",
                Box::new(|s| s.channels[0].args.words[0].index = 16),
            ),
            (
                "short path",
                Box::new(|s| {
                    s.channels[0].args.words[0].path.pop();
                }),
            ),
        ];
        for (name, alter) in cases {
            let mut tx = Settle::new().first(&a, &[1, 2]).inners_for(2);
            alter(&mut tx);
            env.refuses_as(tx, "WordRejected", name);
        }
        let foreign = Settle::new()
            .first(&a, &[1])
            .with_word_of(&other, 1)
            .inners_for(2);
        env.refuses(foreign, "WordRejected");
        env.assert_no_writes();
    });
}

#[test]
fn commitment_signed_by_another_key_for_another_lock_or_too_shallow_is_refused() {
    each_cluster(|env| {
        let a = env.payer_channel(4);
        let stranger = env.stranger_key();
        env.refuses(
            Settle::new()
                .first(&a, &[0, 1])
                .signed_by(stranger)
                .inners_for(2),
            "ChainVerification",
        );
        env.refuses(
            Settle::new()
                .first(&a, &[0, 1])
                .lock_seq(a.lock_seq + 1)
                .inners_for(2),
            "WrongLock",
        );
        let shallow = env.payer_channel(3);
        env.refuses(
            Settle::new().first(&shallow, &[0, 1]).inners_for(2),
            "CommitmentInvalid",
        );
        env.assert_no_writes();
    });
}

#[test]
fn commitment_above_a_quarter_of_the_bond_is_refused() {
    each_cluster(|env| {
        let total = 16 * env.word_value();
        let exact = env.lock_with_bond(4 * total);
        let ok = env.channel_on(&exact, 4);
        env.send(Settle::new().first(&ok, &[0, 1]).inners_for(2))
            .unwrap();
        let short = env.lock_with_bond(4 * total - 1);
        let over = env.channel_on(&short, 4);
        assert_eq!(
            env.send(Settle::new().first(&over, &[0, 1]).inners_for(2))
                .unwrap_err()
                .code(),
            env.error("ChannelAboveBondQuarter")
        );
    });
}

#[test]
fn word_value_other_than_the_mint_value_is_refused() {
    each_cluster(|env| {
        let c = env.payer_channel_with_value(4, env.word_value() + 1);
        env.refuses(
            Settle::new().first(&c, &[0, 1]).inners_for(2),
            "WordValueMismatch",
        );
        env.assert_no_writes();
    });
}

#[test]
fn window_closes_at_expiry_plus_grace_and_at_lock_end() {
    each_cluster(|env| {
        let a = env.payer_channel(4);
        env.warp_to(a.expiry + env.grace());
        env.send(Settle::new().first(&a, &[0, 1]).inners_for(2))
            .unwrap();
        env.warp_to(a.expiry + env.grace() + 1);
        env.refuses(
            Settle::new().again(&a, &[2, 3]).inners_for(2),
            "ChannelWindowClosed",
        );
        let b = env.channel_past_lock_end();
        env.refuses(
            Settle::new().first(&b, &[0, 1]).inners_for(2),
            "ChannelWindowClosed",
        );
    });
}

#[test]
fn words_beyond_the_remaining_backing_fail_and_the_payment_settled_first_is_untouched() {
    each_cluster(|env| {
        let (note, chan) = env.note_and_channel_sharing_backing();
        env.settle_rest(&note).unwrap();
        env.settle_note(&note).unwrap();
        let paid = env.token_balance(note.payee_token);
        env.refuses(
            Settle::new().first(&chan, &[0, 1, 2, 3]).inners_for(4),
            "InsufficientEscrow",
        );
        assert_eq!(env.token_balance(note.payee_token), paid);
        env.assert_no_writes();
    });
}

#[test]
fn over_issuance_between_a_commitment_and_an_issue_burns_twice_the_loss_and_pays_nobody() {
    each_cluster(|env| {
        let (note, chan) = env.note_and_channel_sharing_backing();
        env.settle_rest(&note).unwrap();
        let all: Vec<u16> = (0..16).collect();
        env.send(Settle::new().first(&chan, &all).inners_for(16))
            .unwrap();
        assert!(env.settle_note(&note).is_err());
        let (bond_before, supply_before, paid_before) = (
            env.lock_bond(&chan),
            env.env.supply(),
            env.token_balance(note.payee_token),
        );
        env.claim_unbacked(&note).unwrap();
        let burned = slash::penalty(note.amount, bond_before);
        assert_eq!(burned, 2 * note.amount);
        assert_eq!(bond_before - env.lock_bond(&chan), burned);
        assert_eq!(supply_before - env.env.supply(), burned);
        assert_eq!(env.token_balance(note.payee_token), paid_before);
    });
}

#[test]
fn paused_rewards_still_settle_words() {
    each_cluster(|env| {
        let a = env.payer_channel(4);
        env.pause_rewards();
        env.send(Settle::new().first(&a, &[0, 1]).inners_for(2))
            .unwrap();
        assert!(env.bits_set(&a, &[0, 1]));
    });
}

#[test]
fn channel_closes_only_after_the_delay_and_refunds_its_payer() {
    each_cluster(|env| {
        let a = env.payer_channel(4);
        env.send(Settle::new().first(&a, &[0, 1]).inners_for(2))
            .unwrap();
        assert_eq!(
            env.close_channel(&a).unwrap_err().code(),
            env.error("ChannelStillOpen")
        );
        env.warp_to(a.expiry + env.grace() + 7 * 86_400);
        let before = env.lamports(&env.gateway());
        env.close_channel(&a).unwrap();
        assert!(env.lamports(&env.gateway()) > before);
        env.refuses(
            Settle::new().first(&a, &[2, 3]).inners_for(2),
            "ChannelWindowClosed",
        );
    });
}

#[test]
fn a_channel_cannot_outlive_its_lock_by_more_than_the_delay() {
    each_cluster(|env| {
        let a = env.payer_channel_expiring_after_the_lock();
        env.send(Settle::new().first(&a, &[0, 1]).inners_for(2))
            .unwrap();
        let channel = env.channel(&a);
        assert_eq!(channel.closable_at, a.issuer.lock_until + 7 * 86_400);
    });
}

#[test]
fn channel_pda_uses_the_canonical_bump_only() {
    each_cluster(|env| {
        let a = env.payer_channel(4);
        env.refuses(
            Settle::new()
                .first(&a, &[0, 1])
                .with_noncanonical_channel_bump()
                .inners_for(2),
            "RecordAccounts",
        );
    });
}
