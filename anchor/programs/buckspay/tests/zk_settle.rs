#![cfg(not(feature = "short-windows"))]
mod common;
use buckspay::BuckspayError as E;
use buckspay_protocol::{
    attest::MAX_NOTE_LIFE,
    window::{self, Settle},
    GRACE,
};
use common::{
    zk::{code_of, Cluster, MintPolicy, Zk, ZkSettle},
    *,
};

type Alteration = Box<dyn Fn(&mut ZkSettle)>;

fn each_cluster(f: impl Fn(&mut Zk)) {
    for cluster in [Cluster::Devnet, Cluster::Mainnet] {
        f(&mut Zk::new(cluster));
    }
}

fn is(failed: &common::zk::Failed, error: E) {
    assert_eq!(failed.custom(), code_of(error), "{:?}\n", failed.error);
}

#[test]
fn settles_a_three_spend_note_and_pays_the_payee() {
    each_cluster(|z| {
        let note = z.private_note(3);
        let before = z.balance(&note.payee_ata);
        z.send(&ZkSettle::inline(z, &note)).unwrap();
        assert_eq!(z.balance(&note.payee_ata) - before, note.pay_amount);
        for (output, content) in note.consumed() {
            assert_eq!(z.w.env.spent(&output).unwrap().content, content);
        }
        assert_eq!(
            z.w.env.ledger(&note.lock).backing_left,
            z.w.issuer.backing - note.pay_amount
        );
    });
}

#[test]
fn every_wire_alteration_is_rejected() {
    each_cluster(|z| {
        let note = z.private_note(3);
        let cases: Vec<(&str, Alteration)> = vec![
            ("content", Box::new(|s| s.messages[2].content[0] ^= 1)),
            ("s_out", Box::new(|s| s.messages[1].s_out[31] ^= 1)),
            ("next_bit", Box::new(|s| s.messages[1].next_bit ^= 1)),
            ("pay_amount", Box::new(|s| s.pay_amount += 1)),
            ("expiry", Box::new(|s| s.expiry += 1)),
            ("cum_end", Box::new(|s| s.cum_end += 1)),
            ("amount", Box::new(|s| s.amount += 1)),
            ("proof", Box::new(|s| s.messages[0].proof[40] ^= 1)),
            ("swap", Box::new(|s| s.messages.swap(1, 2))),
            (
                "dropped",
                Box::new(|s| {
                    s.messages.remove(1);
                    s.records.pop();
                }),
            ),
        ];
        for (name, alter) in cases {
            let mut tx = ZkSettle::inline(z, &note);
            alter(&mut tx);
            assert!(z.send(&tx).is_err(), "{name} accepted");
        }
        assert!(z.no_records_written(&note));
        assert_eq!(z.balance(&note.payee_ata), 0);
    });
}

#[test]
fn a_proof_of_another_issuer_is_rejected() {
    each_cluster(|z| {
        let note = z.private_note(2);
        let mut tx = ZkSettle::inline(z, &note);
        let other = z.w.culprit.key.sec1();
        tx.issuer_key = other;
        tx.lock = z.w.culprit.lock;
        let failed = z.send(&tx).unwrap_err();
        assert!(
            matches!(failed.custom(), c if c == code_of(E::ProofRejected) || c == code_of(E::WrongLock))
        );
        assert!(z.no_records_written(&note));
    });
}

#[test]
fn issue_beyond_backing_or_with_another_mint_is_refused() {
    each_cluster(|z| {
        let over = z.note_beyond_backing(2);
        is(
            &z.send(&ZkSettle::inline(z, &over)).unwrap_err(),
            E::WrongLock,
        );
        let note = z.private_note(2);
        let mut tx = ZkSettle::inline(z, &note);
        tx.mint = z.w.env.add_mint(6);
        assert!(z.send(&tx).is_err());
    });
}

#[test]
fn payee_must_own_the_token_account() {
    each_cluster(|z| {
        let note = z.private_note(2);
        let mut tx = ZkSettle::inline(z, &note);
        tx.payee_ata = z.payee_b_ata;
        is(&z.send(&tx).unwrap_err(), E::ProofRejected);
        assert_eq!(z.balance(&z.payee_b_ata), 0);
    });
}

#[test]
fn stale_verifying_key_fails_before_pairing() {
    each_cluster(|z| {
        let note = z.private_note(2);
        let mut tx = ZkSettle::inline(z, &note);
        tx.vk_sha256[0] ^= 1;
        let failed = z.send(&tx).unwrap_err();
        is(&failed, E::StaleVerifyingKey);
        assert!(
            failed.cu < 20_000,
            "must stop before the batch verification: {}",
            failed.cu
        );
    });
}

#[test]
fn non_canonical_s_out_is_refused() {
    each_cluster(|z| {
        let note = z.private_note(2);
        let mut tx = ZkSettle::inline(z, &note);
        tx.messages[0].s_out = common::zk::R_BYTES;
        is(&z.send(&tx).unwrap_err(), E::NonCanonicalPublic);
    });
}

#[test]
fn payment_then_change_branch_reuses_the_prefix() {
    each_cluster(|z| {
        let (payment, change) = z.branch_notes();
        z.send(&ZkSettle::inline(z, &payment)).unwrap();
        z.send(&ZkSettle::inline(z, &change)).unwrap();
        assert_eq!(z.balance(&payment.payee_ata), payment.pay_amount);
        assert_eq!(z.balance(&change.payee_ata), change.pay_amount);
    });
}

#[test]
fn second_content_for_a_recorded_output_conflicts_and_the_clear_claim_works() {
    each_cluster(|z| {
        let winner = z.winning_note();
        z.send(&ZkSettle::inline(z, &winner)).unwrap();
        let loser = z.w.losing(0, 2);
        let rival = z.note_of_to(
            common::zk::Key2::Current,
            z.w.base(0)
                .spend1_to_account(&z.w.culprit.key, 0, &z.payee_b, 0, 2),
            z.payee_b,
            z.payee_b_ata,
        );
        is(
            &z.send(&ZkSettle::inline(z, &rival)).unwrap_err(),
            E::ConflictingSpend,
        );
        z.w.claim(&loser).unwrap();
        let claim = z.w.env.claim(&loser.last.first.id).unwrap();
        assert_eq!(claim.lock, z.w.culprit.lock);
    });
}

#[test]
fn private_and_clear_settlements_share_records() {
    each_cluster(|z| {
        let note = z.private_note_tagged(2, 4);
        let ixs = record_prefix_ixs(&z.gateway(), &z.w.issuer, &note.chain.prefix(1), 0);
        z.w.env.submit(&ixs).unwrap();
        z.send(&ZkSettle::inline(z, &note)).unwrap();
    });
}

#[test]
fn window_closes_at_expiry_plus_grace() {
    each_cluster(|z| {
        let open = z.private_note_tagged(2, 5);
        let late = z.private_note_tagged(2, 6);
        z.w.env.warp(i64::from(open.expiry) + i64::from(GRACE));
        z.send(&ZkSettle::inline(z, &open)).unwrap();
        z.w.env.warp(i64::from(late.expiry) + i64::from(GRACE) + 1);
        let failed = z.send(&ZkSettle::inline(z, &late)).unwrap_err();
        is(&failed, E::SettlementClosed);
        assert!(z.no_records_written(&late));
    });
}

#[test]
fn lock_ended_is_refused() {
    each_cluster(|z| {
        let (issuer, note) = z.lock_ending_before_expiry();
        z.w.env.warp(i64::from(issuer.lock_until) + 1);
        assert_eq!(
            window::settle(note.expiry, issuer.lock_until, z.w.env.now()),
            Settle::LockEnded
        );
        let failed = z.send(&ZkSettle::inline(z, &note)).unwrap_err();
        is(&failed, E::LockEnded);
        assert!(z.no_records_written(&note));
    });
}

#[test]
fn paused_refuses_before_verification_and_unpausing_restores() {
    each_cluster(|z| {
        let note = z.private_note(2);
        let (pauser, admin, stranger) = (
            z.pauser.insecure_clone(),
            z.admin.insecure_clone(),
            z.stranger.insecure_clone(),
        );
        z.set_paused(&pauser, true).unwrap();
        let failed = z.send(&ZkSettle::inline(z, &note)).unwrap_err();
        is(&failed, E::ZkPaused);
        assert!(
            failed.cu < 20_000,
            "must stop before the batch verification: {}",
            failed.cu
        );
        assert!(
            z.set_paused(&pauser, false).is_err(),
            "the pauser may only pause"
        );
        assert!(z.set_paused(&stranger, true).is_err());
        z.set_paused(&admin, false).unwrap();
        z.send(&ZkSettle::inline(z, &note)).unwrap();
    });
}

#[test]
fn only_the_admin_changes_caps_fees_keys_and_authorities() {
    each_cluster(|z| {
        let signers = [
            z.pauser.insecure_clone(),
            z.stranger.insecure_clone(),
            z.w.env.payer.insecure_clone(),
        ];
        let nobody = z.stranger.pubkey();
        for signer in &signers {
            assert!(z.set_mint_policy(signer, MintPolicy::test()).is_err());
            assert!(z.rotate_vk(signer, true).is_err());
            assert!(z.set_authorities(signer, nobody, nobody).is_err());
        }
        assert!(z.revoke_previous_vk(&signers[1]).is_err());
        let ix = z.init_config_ix(&z.stranger.pubkey(), &common::zk::key_hashes(&[0; 32]));
        let stranger = z.stranger.insecure_clone();
        assert!(
            z.send_as(&stranger, ix).is_err(),
            "only the upgrade authority initialises"
        );
        let ix = z.init_config_ix(&z.authority.pubkey(), &common::zk::key_hashes(&[0; 32]));
        let authority = z.authority.insecure_clone();
        assert!(
            z.send_as(&authority, ix).is_err(),
            "the config exists already"
        );
    });
}

#[test]
fn init_refuses_a_key_other_than_the_compiled_one() {
    for cluster in [Cluster::Devnet, Cluster::Mainnet] {
        let mut z = Zk::bare(cluster);
        let ix = z.init_config_ix(&z.authority.pubkey(), &common::zk::key_hashes(&[7; 32]));
        let authority = z.authority.insecure_clone();
        assert_eq!(
            z.send_as(&authority, ix).unwrap_err().custom(),
            code_of(E::StaleVerifyingKey)
        );
    }
}

#[test]
fn lock_cap_bounds_draws_per_window() {
    each_cluster(|z| {
        let admin = z.admin.insecure_clone();
        z.set_mint_policy(
            &admin,
            MintPolicy {
                lock_cap: 100_000_000,
                global_cap: 1_000_000_000,
                ..MintPolicy::test()
            },
        )
        .unwrap();
        let first = z.private_note_paying(&z.w.issuer, 2, 60_000_000);
        z.send(&ZkSettle::inline(z, &first)).unwrap();
        let over = z.private_note_paying(&z.w.issuer, 2, 41_000_000);
        is(
            &z.send(&ZkSettle::inline(z, &over)).unwrap_err(),
            E::ZkCapExceeded,
        );
        assert!(z.no_records_written(&over));
        let exact = z.private_note_paying(&z.w.issuer, 2, 40_000_000);
        z.send(&ZkSettle::inline(z, &exact)).unwrap();
        z.warp_seconds(2 * buckspay::ZK_CAP_WINDOW_SECS);
        z.send(&ZkSettle::inline(z, &over)).unwrap();
    });
}

#[test]
fn global_cap_bounds_draws_across_locks() {
    each_cluster(|z| {
        let admin = z.admin.insecure_clone();
        z.set_mint_policy(
            &admin,
            MintPolicy {
                lock_cap: 100_000_000,
                global_cap: 1_000_000_000,
                ..MintPolicy::test()
            },
        )
        .unwrap();
        z.set_mint_policy(
            &admin,
            MintPolicy {
                lock_cap: 15_000_000,
                global_cap: 150_000_000,
                ..MintPolicy::test()
            },
        )
        .unwrap();
        for seed in 8..=16u8 {
            let lock = z.funded_lock(seed);
            let note = z.private_note_paying(&lock, 2, 15_000_000);
            z.send(&ZkSettle::inline(z, &note)).unwrap();
        }
        let (b, c) = (z.funded_lock(7), z.funded_lock(17));
        let ten = z.private_note_paying(&b, 2, 10_000_000);
        z.send(&ZkSettle::inline(z, &ten)).unwrap();
        let over = z.private_note_paying(&c, 2, 6_000_000);
        is(
            &z.send(&ZkSettle::inline(z, &over)).unwrap_err(),
            E::ZkCapExceeded,
        );
        let rest = z.private_note_paying(&c, 2, 5_000_000);
        z.send(&ZkSettle::inline(z, &rest)).unwrap();
    });
}

#[test]
fn lock_cap_above_a_tenth_of_the_global_cap_is_refused() {
    each_cluster(|z| {
        let admin = z.admin.insecure_clone();
        let policy = |lock_cap| MintPolicy {
            global_cap: 1_000,
            lock_cap,
            ..MintPolicy::test()
        };
        z.set_mint_policy(&admin, policy(100)).unwrap();
        is(
            &z.set_mint_policy(&admin, policy(101)).unwrap_err(),
            E::LockCapTooHigh,
        );
    });
}

#[test]
fn record_fee_is_withheld_for_new_records_only() {
    each_cluster(|z| {
        let admin = z.admin.insecure_clone();
        z.set_mint_policy(
            &admin,
            MintPolicy {
                record_fee: 7,
                ..MintPolicy::test()
            },
        )
        .unwrap();
        let (payment, change) = z.branch_notes();
        let fees = z.balance(&z.fee_account);
        let before = z.balance(&payment.payee_ata);
        z.send(&ZkSettle::inline(z, &payment)).unwrap();
        let created = payment.consumed().len() as u64;
        assert_eq!(
            z.balance(&payment.payee_ata) - before,
            payment.pay_amount - 7 * created
        );
        assert_eq!(z.balance(&z.fee_account) - fees, 7 * created);
        let fees = z.balance(&z.fee_account);
        z.send(&ZkSettle::inline(z, &change)).unwrap();
        let created = change
            .consumed()
            .iter()
            .filter(|c| !payment.consumed().contains(c))
            .count() as u64;
        assert_eq!(created, 1);
        assert_eq!(
            z.balance(&change.payee_ata),
            change.pay_amount - 7 * created
        );
        assert_eq!(z.balance(&z.fee_account) - fees, 7 * created);
    });
}

#[test]
fn fee_goes_to_the_mint_fee_account() {
    each_cluster(|z| {
        let admin = z.admin.insecure_clone();
        z.set_mint_policy(
            &admin,
            MintPolicy {
                record_fee: 7,
                ..MintPolicy::test()
            },
        )
        .unwrap();
        let note = z.private_note(2);
        let mut tx = ZkSettle::inline(z, &note);
        tx.fee_account = z.payee_b_ata;
        is(&z.send(&tx).unwrap_err(), E::WrongFeeAccount);
        assert_eq!(z.balance(&z.payee_b_ata), 0);
    });
}

#[test]
fn amount_not_above_the_record_fee_is_refused() {
    each_cluster(|z| {
        let admin = z.admin.insecure_clone();
        z.set_mint_policy(
            &admin,
            MintPolicy {
                record_fee: 10,
                ..MintPolicy::test()
            },
        )
        .unwrap();
        let dust = z.private_note_paying(&z.w.issuer, 1, 10);
        is(
            &z.send(&ZkSettle::inline(z, &dust)).unwrap_err(),
            E::BelowRecordFee,
        );
        assert!(z.no_records_written(&dust));
    });
}

#[test]
fn previous_vk_is_accepted_until_rotation_plus_note_life_and_grace() {
    each_cluster(|z| {
        z.before_rotation();
        let (old, late) = (
            z.private_note_under_previous_vk(2, 1),
            z.private_note_under_previous_vk(2, 2),
        );
        let admin = z.admin.insecure_clone();
        let rotated_at = z.rotate_vk(&admin, true).unwrap();
        z.send(&ZkSettle::inline(z, &old)).unwrap();
        z.w.env
            .warp(rotated_at + i64::from(MAX_NOTE_LIFE) + i64::from(GRACE));
        z.send(&ZkSettle::inline(z, &late)).unwrap();
    });
}

#[test]
fn previous_vk_is_refused_one_second_after_its_window() {
    each_cluster(|z| {
        z.before_rotation();
        let late = z.private_note_under_previous_vk(2, 2);
        let admin = z.admin.insecure_clone();
        let rotated_at = z.rotate_vk(&admin, true).unwrap();
        z.w.env
            .warp(rotated_at + i64::from(MAX_NOTE_LIFE) + i64::from(GRACE) + 1);
        is(
            &z.send(&ZkSettle::inline(z, &late)).unwrap_err(),
            E::StaleVerifyingKey,
        );
    });
}

#[test]
fn revoked_previous_vk_is_refused_at_once() {
    each_cluster(|z| {
        z.before_rotation();
        let old = z.private_note_under_previous_vk(2, 1);
        let admin = z.admin.insecure_clone();
        z.rotate_vk(&admin, true).unwrap();
        z.revoke_previous_vk(&admin).unwrap();
        is(
            &z.send(&ZkSettle::inline(z, &old)).unwrap_err(),
            E::StaleVerifyingKey,
        );
    });
}

#[test]
fn pauser_may_revoke_the_previous_vk_and_rotation_may_drop_it() {
    each_cluster(|z| {
        z.before_rotation();
        let (old, dropped) = (
            z.private_note_under_previous_vk(2, 1),
            z.private_note_under_previous_vk(2, 3),
        );
        let (admin, pauser, stranger) = (
            z.admin.insecure_clone(),
            z.pauser.insecure_clone(),
            z.stranger.insecure_clone(),
        );
        z.rotate_vk(&admin, true).unwrap();
        assert!(z.revoke_previous_vk(&stranger).is_err());
        z.revoke_previous_vk(&pauser).unwrap();
        is(
            &z.send(&ZkSettle::inline(z, &old)).unwrap_err(),
            E::StaleVerifyingKey,
        );
        z.before_rotation();
        z.rotate_vk(&admin, false).unwrap();
        assert_eq!(z.config().rotated_at, 0);
        is(
            &z.send(&ZkSettle::inline(z, &dropped)).unwrap_err(),
            E::StaleVerifyingKey,
        );
    });
}

#[test]
fn sixteen_spends_settle_through_the_buffer_and_refund_rent() {
    each_cluster(|z| {
        let note = z.private_note(16);
        let gateway = z.gateway();
        let before = z.w.env.lamports(&gateway);
        let buffer = z.buffer_with(&note, 1, 2).unwrap();
        let landed = z
            .send(&ZkSettle::from_buffer(z, &note, buffer))
            .unwrap_or_else(|e| panic!("{e:?}\n{}", z.w.env.logs()));
        assert!(z
            .w
            .env
            .svm
            .get_account(&buffer)
            .is_none_or(|a| a.lamports == 0));
        assert_eq!(z.balance(&note.payee_ata), note.pay_amount);
        assert!(landed.size < 4_096);
        let spent = before - z.w.env.lamports(&gateway);
        let rent: u64 = note
            .consumed()
            .iter()
            .map(|_| {
                z.w.env
                    .rent(8 + <buckspay::Spent as anchor_lang::Space>::INIT_SPACE)
            })
            .sum();
        assert!(
            spent >= rent,
            "the gateway pays the records' rent and the transaction fees"
        );
    });
}

#[test]
fn incomplete_or_foreign_buffer_is_refused() {
    each_cluster(|z| {
        let note = z.private_note(16);
        let partial = z.buffer_with(&note, 2, 1).unwrap();
        is(
            &z.send(&ZkSettle::from_buffer(z, &note, partial))
                .unwrap_err(),
            E::BufferIncomplete,
        );
        let stranger = z.stranger.insecure_clone();
        let ix = z.close_ix(&stranger.pubkey(), 2);
        assert!(
            z.send_as(&stranger, ix).is_err(),
            "the stranger has no buffer at that address"
        );
        let gateway = z.gateway();
        let ix = z.close_ix(&gateway, 2);
        is(&z.send_ix(ix.clone()).unwrap_err(), E::BufferNotStale);
        z.warp_seconds(i64::from(buckspay::STALE_BUFFER_SECS));
        z.send_ix(ix).unwrap();
        assert!(z
            .w
            .env
            .svm
            .get_account(&partial)
            .is_none_or(|a| a.lamports == 0));
    });
}

#[test]
fn a_buffer_of_another_payer_cannot_settle() {
    each_cluster(|z| {
        let note = z.private_note(16);
        let buffer = z.buffer_with(&note, 3, 2).unwrap();
        let stranger = z.stranger.insecure_clone();
        let tx = ZkSettle::from_buffer(z, &note, buffer);
        let ix = tx.ix(&stranger.pubkey());
        assert!(z.send_as(&stranger, ix).is_err());
        assert!(z.no_records_written(&note));
    });
}

#[test]
fn non_recordable_output_is_refused() {
    each_cluster(|z| {
        let note = z.note_with_unrecordable_output();
        is(
            &z.send(&ZkSettle::inline(z, &note)).unwrap_err(),
            E::UnrecordableOutput,
        );
    });
}

#[test]
fn a_disabled_mint_is_refused() {
    for cluster in [Cluster::Devnet, Cluster::Mainnet] {
        let mut z = Zk::bare(cluster);
        z.init_config(&common::zk::key_hashes(buckspay_zk_verify::vk::VK.sha256));
        let note = z.private_note(2);
        is(
            &z.send(&ZkSettle::inline(&z, &note)).unwrap_err(),
            E::MintNotEnabled,
        );
    }
}
