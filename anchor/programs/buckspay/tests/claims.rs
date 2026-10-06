mod common;
use anchor_lang::prelude::Pubkey;
use buckspay::BuckspayError as E;
use buckspay_protocol::{
    lock::{CLAIM_WINDOW, RECORD_TTL},
    window, CHALLENGE, GRACE,
};
use common::claims::*;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// A double spend that happened: the culprit paid the winner's account and the victim for one
/// output, and the winner's chain settled first.
fn double_spend() -> (World, Chain, Chain) {
    let mut w = world();
    let (winning, losing) = (w.winning(0), w.losing(0, 2));
    w.settle(&winning).unwrap();
    (w, winning, losing)
}

#[test]
fn the_loser_of_a_double_spend_files_and_twice_its_loss_burns_at_once() {
    let (mut w, _, losing) = double_spend();
    let (before, supply) = (w.balances(), w.env.supply());
    let landed = w.claim(&losing).unwrap();
    eprintln!(
        "claim_lost_spend: {} CU, {} bytes",
        landed.units, landed.size
    );

    let payment = losing.last.first;
    let claim = w.env.claim(&payment.id).unwrap();
    assert_eq!(claim.lock, w.culprit.lock);
    assert_eq!((claim.amount, claim.burned), (AMOUNT, 2 * AMOUNT));
    assert_eq!(claim.payer, w.payer());
    let expiry = w.env.spent(&consumed_outputs(&losing)[0]).unwrap().expiry;
    assert_eq!(
        u64::from(claim.closable_at),
        window::claim_closable_at(expiry, w.culprit.lock_until)
    );

    // The bond is down by twice the loss, in the same transaction, and the pool is empty again.
    let ledger = w.env.ledger(&w.culprit.lock);
    assert_eq!(
        (ledger.bond_free, ledger.bond_slashed),
        (BOND - 2 * AMOUNT, 0)
    );
    // Nothing but the burn left the cast: nobody was paid, the victim included.
    w.assert_only_a_burn(&before, supply, &w.culprit.lock, 2 * AMOUNT);
    assert_eq!(w.env.balance(&w.victim.wallet_token), 0);
}

#[test]
fn anyone_files_a_claim_and_it_pays_nobody() {
    // The filer is a stranger with no token account and no device: it holds the two conflicting
    // chains and nothing else, and gets nothing for it but the loss of its float.
    let (mut w, _, losing) = double_spend();
    let stranger = Keypair::new();
    w.env
        .svm
        .airdrop(&stranger.pubkey(), 2_000_000_000)
        .unwrap();
    let (before, supply) = (w.balances(), w.env.supply());
    let lamports = w.env.lamports(&stranger.pubkey());
    let ixs = claim_lost_ixs(
        &stranger.pubkey(),
        &w.culprit.lock,
        w.culprit.key.sec1(),
        0,
        &w.env.mint,
        &losing,
    );
    w.env.send(&stranger, &ixs).unwrap();
    w.assert_only_a_burn(&before, supply, &w.culprit.lock, 2 * AMOUNT);
    let rent = w
        .env
        .rent(8 + <buckspay::Claim as anchor_lang::Space>::INIT_SPACE);
    assert!(w.env.lamports(&stranger.pubkey()) + rent <= lamports);
    assert_eq!(
        w.env.claim(&losing.last.first.id).unwrap().payer,
        stranger.pubkey()
    );
}

#[test]
fn nothing_is_claimed_before_the_winner_settles_or_by_the_winner_or_after_a_reclaim() {
    let mut w = world();
    let (winning, losing) = (w.winning(0), w.losing(0, 2));
    // No record yet: nobody has lost.
    assert_eq!(w.claim(&losing).unwrap_err(), code(1, E::NoRecord));
    w.settle(&winning).unwrap();
    // The winner's own branch is not a loss.
    assert_eq!(w.claim(&winning).unwrap_err(), code(1, E::NotConflicting));

    // A reclaim is no spend: an output taken back after its grace is not a double spend.
    let mut w = world();
    let (base, losing) = (w.base(0), w.losing(0, 2));
    w.env.warp(i64::from(w.expiry + GRACE) + 1);
    let payer = w.payer();
    let ixs = reclaim_ixs(
        &w.env,
        &payer,
        &w.issuer,
        &base,
        0,
        &w.culprit.key,
        &w.culprit.wallet_token,
    );
    w.env.submit(&ixs).unwrap();
    assert_eq!(w.claim(&losing).unwrap_err(), code(1, E::NotClaimable));
}

#[test]
fn a_claim_needs_the_culprits_signature_and_the_lock_it_names() {
    let (mut w, _, losing) = double_spend();
    let (payer, lock) = (w.payer(), w.culprit.lock);
    let culprit_key = w.culprit.key.sec1();
    let mint = w.env.mint;

    // Without a verification of the culprit's spend the transaction proves nothing.
    let mut ixs = claim_lost_ixs(&payer, &lock, culprit_key, 0, &mint, &losing);
    ixs.remove(0);
    assert_eq!(
        w.env.submit(&ixs).unwrap_err(),
        code(0, E::ChainVerification)
    );

    // A verification of another message does not match what the program rebuilds.
    let mut ixs = claim_lost_ixs(&payer, &lock, culprit_key, 0, &mint, &losing);
    let other = &losing.signed[0];
    ixs[0] = precompile_ix(&[(other.key, other.envelope)], &[other.signature]);
    assert_eq!(
        w.env.submit(&ixs).unwrap_err(),
        code(1, E::ChainVerification)
    );

    // Naming a lock that did not back the culprit's spend.
    let ixs = claim_lost_ixs(
        &payer,
        &w.issuer.lock,
        w.issuer.key.sec1(),
        0,
        &mint,
        &losing,
    );
    assert_eq!(w.env.submit(&ixs).unwrap_err(), code(1, E::ConflictProof));
    assert_eq!(w.env.ledger(&lock).bond_free, BOND);

    // The honest claim lands once and only once, and burns once.
    w.claim(&losing).unwrap();
    assert_eq!(w.claim(&losing).unwrap_err(), code(1, E::AlreadyClaimed));
    assert_eq!(w.env.ledger(&lock).bond_free, BOND - 2 * AMOUNT);
}

#[test]
fn a_culprit_cannot_claim_from_itself() {
    let (mut w, _, _) = double_spend();
    let to_self = w.losing_to(0, 5, w.culprit.key.owner());
    assert_eq!(w.claim(&to_self).unwrap_err(), code(1, E::NotClaimable));
}

#[test]
fn claims_are_accepted_until_the_challenge_ends_and_not_after() {
    let deadline = |w: &World| i64::from(window::report_deadline(w.expiry) as u32);
    for (offset, ok) in [(0, true), (1, false)] {
        let (mut w, _, losing) = double_spend();
        assert_eq!(deadline(&w), i64::from(w.expiry + GRACE + CHALLENGE));
        w.env.warp(deadline(&w) + offset);
        let result = w.claim(&losing);
        if ok {
            result.unwrap();
        } else {
            assert_eq!(result.unwrap_err(), code(1, E::ClaimTooLate));
        }
    }
}

#[test]
#[cfg(not(feature = "short-windows"))] // the windows are days long
fn the_end_of_the_lock_closes_claims_before_the_challenge_does() {
    // The note expires so late that its challenge would end after the lock does.
    for (offset, ok) in [(-1, true), (0, false)] {
        let mut w = world_expiring(50);
        let (winning, losing) = (w.winning(0), w.losing(0, 2));
        w.settle(&winning).unwrap();
        assert!(window::report_deadline(w.expiry) > u64::from(w.culprit.lock_until));
        w.env.warp(i64::from(w.culprit.lock_until) + offset);
        let result = w.claim(&losing);
        if ok {
            result.unwrap();
        } else {
            assert_eq!(result.unwrap_err(), code(1, E::LockEnded));
        }
    }
}

#[test]
fn claims_burn_the_sum_of_their_losses_until_the_bond_is_gone() {
    // Five notes of the maximum payment against a bond of four times as much: each claim burns
    // twice its loss while the bond lasts, the third finds the last half of what it asks, and
    // after that nothing is left to burn.
    let mut w = world();
    let mut free = vec![];
    for i in 0..5u64 {
        let start = i * LIMIT;
        let (winning, losing) = (w.winning_of(start, LIMIT), w.losing_of(start, 2, LIMIT));
        w.settle(&winning).unwrap();
        let landed = w.claim(&losing);
        match landed {
            Ok(_) => {
                let claim = w.env.claim(&losing.last.first.id).unwrap();
                free.push((claim.burned, w.env.ledger(&w.culprit.lock).bond_free));
            }
            Err(error) => {
                assert_eq!(error, code(1, E::NoBond));
                free.push((0, w.env.ledger(&w.culprit.lock).bond_free));
            }
        }
    }
    assert_eq!(
        free,
        vec![
            (50_000_000, 50_000_000),
            (50_000_000, 0),
            (0, 0),
            (0, 0),
            (0, 0)
        ]
    );
    let ledger = w.env.ledger(&w.culprit.lock);
    assert_eq!((ledger.bond_free, ledger.bond_slashed), (0, 0));
}

#[test]
fn a_claim_on_a_drained_lock_fails_and_says_so() {
    let mut w = world();
    let notes: Vec<(Chain, Chain)> = (0..3u64)
        .map(|i| {
            (
                w.winning_of(i * LIMIT, LIMIT),
                w.losing_of(i * LIMIT, 2 + i as u8, LIMIT),
            )
        })
        .collect();
    for (winning, _) in &notes {
        w.settle(winning).unwrap();
    }
    w.claim(&notes[0].1).unwrap();
    w.claim(&notes[1].1).unwrap();
    assert_eq!(w.env.ledger(&w.culprit.lock).bond_free, 0);
    // The third victim of the same lock has no bond left to burn, and no claim was written.
    assert_eq!(w.claim(&notes[2].1).unwrap_err(), code(1, E::NoBond));
    assert!(w.env.claim(&notes[2].1.last.first.id).is_none());
}

#[test]
#[cfg(not(feature = "short-windows"))] // the windows are days long
fn what_burns_is_gone_from_the_lock_and_the_wallet_withdraws_the_rest() {
    let mut w = world_expiring(50);
    let (winning, losing) = (w.winning(0), w.losing(0, 2));
    w.settle(&winning).unwrap();
    let lock = w.culprit.lock;
    let (key, until) = (w.culprit.key.sec1(), w.culprit.lock_until);
    w.env.warp(i64::from(until) - 10);
    let supply = w.env.supply();
    w.claim(&losing).unwrap();
    let wallet = w.culprit.wallet.insecure_clone();
    let wallet_token = w.culprit.wallet_token;
    let rent_receiver = wallet.pubkey();
    let withdraw = |w: &mut World| {
        let ix = withdraw_lock_ix(
            &w.env,
            &wallet.pubkey(),
            &key,
            &lock,
            0,
            &wallet_token,
            &rent_receiver,
        );
        w.env.send(&wallet, &[ix])
    };
    assert_eq!(withdraw(&mut w).unwrap_err(), code(0, E::WithdrawTooEarly));
    w.env.warp(i64::from(until + CLAIM_WINDOW));
    // The wallet takes the backing and the free bond that is left, and the escrow is empty: no
    // pool outlives a claim.
    withdraw(&mut w).unwrap();
    assert_eq!(w.env.balance(&wallet_token), 10_000_000 + BOND - 2 * AMOUNT);
    assert_eq!(supply - w.env.supply(), 2 * AMOUNT);
    assert!(w
        .env
        .svm
        .get_account(&escrow_address(&lock))
        .is_none_or(|a| a.data.is_empty()));
    w.env.warp(i64::from(until + RECORD_TTL));
    w.env
        .submit(&[close_lock_ix(&key, &lock, 0, &rent_receiver)])
        .unwrap();
    assert!(w
        .env
        .svm
        .get_account(&lock)
        .is_none_or(|a| a.data.is_empty()));
}

#[test]
fn a_claim_closes_only_after_its_retention_and_returns_its_rent_to_whoever_paid() {
    let (mut w, _, losing) = double_spend();
    w.claim(&losing).unwrap();
    let payer = w.payer();
    let claim = claim_address(&losing.last.first.id);
    let closable = w.env.claim(&losing.last.first.id).unwrap().closable_at;
    // Neither one second early nor to anybody else.
    for early in [w.env.now() + 1, closable - 1] {
        w.env.warp(i64::from(early));
        assert_eq!(
            w.env
                .submit(&[close_records_ix(&[(claim, payer)])])
                .unwrap_err(),
            code(0, E::RecordNotClosable),
            "at {early}"
        );
    }
    w.env.warp(i64::from(closable));
    let thief = Pubkey::new_unique();
    assert_eq!(
        w.env
            .submit(&[close_records_ix(&[(claim, thief)])])
            .unwrap_err(),
        code(0, E::RecordAccounts)
    );
    let before = w.env.lamports(&payer);
    let landed = w
        .env
        .submit(&[close_records_ix(&[(claim, payer)])])
        .unwrap();
    eprintln!(
        "close_records, one claim: {} CU, {} bytes",
        landed.units, landed.size
    );
    assert!(w.env.claim(&losing.last.first.id).is_none());
    assert!(w.env.lamports(&payer) > before);
    // Only claims are closed by this instruction.
    let ix = close_records_ix(&[(ledger_address(&w.culprit.lock), payer)]);
    assert!(w.env.submit(&[ix]).is_err());
}

#[test]
fn a_claim_lives_by_its_output_and_a_long_lock_does_not_lengthen_it() {
    // Two worlds, the same note: one lock lasts 60 days, the other 300. The claim of the same
    // output closes at the same second in both.
    let closable = |lock_days: u32| {
        let mut env = Env::new(TokenKind::Classic);
        let issuer = env.issuer(1, BOND, 1_000_000_000, 60);
        let culprit = env.issuer(2, BOND, 10_000_000, lock_days);
        let victim = env.actor(3);
        let winner = Pubkey::new_unique();
        let winner_token = env.token_account_of(&winner, 0);
        let expiry = expiry_of(&env, 10);
        let mut w = World {
            env,
            issuer,
            culprit,
            victim,
            winner,
            winner_token,
            expiry,
        };
        let (winning, losing) = (w.winning(0), w.losing(0, 2));
        w.settle(&winning).unwrap();
        w.claim(&losing).unwrap();
        (
            w.env.claim(&losing.last.first.id).unwrap().closable_at,
            w.expiry,
        )
    };
    let (short, expiry) = closable(60);
    let (long, _) = closable(300);
    assert_eq!(short, long);
    assert_eq!(
        u64::from(short),
        u64::from(expiry) + u64::from(GRACE + CHALLENGE + CLAIM_WINDOW + RECORD_TTL)
    );
}

#[test]
fn addresses_that_were_sent_lamports_first_do_not_stop_a_claim() {
    let mut w = world();
    let (winning, losing) = (w.winning(0), w.losing(0, 2));
    w.settle(&winning).unwrap();
    let claim = claim_address(&losing.last.first.id);
    w.env
        .svm
        .set_account(
            claim,
            solana_account::Account {
                lamports: 1_000,
                data: vec![],
                owner: solana_sdk_ids::system_program::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    w.claim(&losing).unwrap();
    assert_eq!(w.env.claim(&losing.last.first.id).unwrap().amount, AMOUNT);
}

#[test]
fn a_claim_is_refused_for_an_output_that_cannot_be_claimed_whoever_signed_it() {
    // A culprit grinds the salt of the payment it signs until the victim's claim address is on the
    // curve. Receivers refuse such an output (01 section 1.6), so no victim holds one; the program
    // refuses it too, and the refusal costs a handful of compute units, not a search.
    let mut w = world();
    let winning = w.winning(0);
    w.settle(&winning).unwrap();
    let base = w.base(0);
    let culprit = &w.culprit.key;
    let ground = (0u16..)
        .map(|n| {
            base.clone()
                .spend_raw(culprit, 0, |c| buckspay_protocol::Spend {
                    input: c.id,
                    lock_seq: 0,
                    salt: salted([9; 16], n),
                    outputs: buckspay_protocol::Outputs::One {
                        owner: w.victim.key.owner(),
                        caveats: buckspay_protocol::Caveats {
                            hops_left: c.caveats.hops_left - 1,
                            expiry: c.caveats.expiry - buckspay_protocol::lock::EXPIRY_STEP,
                            ..c.caveats
                        },
                    },
                })
        })
        .find(|chain| {
            spent_address_of(&chain.last.first.id).is_some()
                && claim_address_of(&chain.last.first.id).is_none()
        })
        .unwrap();
    let landed = w.claim(&ground).unwrap_err();
    assert_eq!(landed, code(1, E::UnrecordableOutput));
    assert_eq!(w.env.ledger(&w.culprit.lock).bond_free, BOND);
}

/// An issuer's lock backs credit that only its own wallet (the authority) can take: the holder
/// pays it at two points that had not synced, so the organiser itself is the payee of both.
mod authority_credit {
    use super::*;
    use buckspay_protocol::{flags, Caveats, Owner, ScopeKind, NO_LOCK};

    fn credit(w: &World, holder: &Key, authority: &Pubkey) -> Chain {
        Chain::issue(
            &w.issuer.key,
            &w.env.mint,
            0,
            0,
            AMOUNT,
            holder.owner(),
            Caveats {
                flags: flags::AUTHORITY_ONLY,
                scope_kind: ScopeKind::Authority,
                scope: Owner::Account(authority.to_bytes()).scope_hash(),
                ..caveats(w.expiry, 4)
            },
        )
    }

    fn at_a_point(w: &World, holder: &Key, authority: &Pubkey, salt: u8) -> Chain {
        credit(w, holder, authority).spend1_to_account(holder, 0, authority, NO_LOCK, salt)
    }

    fn settle_to(w: &mut World, chain: &Chain, destination: &Pubkey) {
        let ixs = settle_ixs(&w.env, &w.payer(), &w.issuer, chain, destination);
        w.env.submit(&ixs).unwrap();
    }

    fn file(w: &mut World, chain: &Chain) -> Result<Landed, solana_transaction::TransactionError> {
        let ixs = claim_lost_ixs(
            &w.payer(),
            &w.issuer.lock,
            w.issuer.key.sec1(),
            0,
            &w.env.mint,
            chain,
        );
        w.env.submit(&ixs)
    }

    #[test]
    fn a_loss_paid_to_the_lock_owners_own_wallet_burns_nothing() {
        let mut w = world();
        let (holder, org) = (Key::new(40), w.issuer.wallet.pubkey());
        let (first, second) = (
            at_a_point(&w, &holder, &org, 1),
            at_a_point(&w, &holder, &org, 2),
        );
        let token = w.issuer.wallet_token;
        settle_to(&mut w, &first, &token);
        let (before, supply) = (w.balances(), w.env.supply());
        assert_eq!(file(&mut w, &second).unwrap_err(), code(1, E::NotClaimable));
        assert_eq!(w.env.supply(), supply);
        assert_eq!(w.balances(), before);
        assert_eq!(w.env.ledger(&w.issuer.lock).bond_free, BOND);
    }

    #[test]
    fn a_loss_paid_to_another_account_still_burns() {
        let mut w = world();
        let (holder, other) = (Key::new(40), w.winner);
        let (first, second) = (
            at_a_point(&w, &holder, &other, 1),
            at_a_point(&w, &holder, &other, 2),
        );
        w.settle(&first).unwrap();
        let (before, supply) = (w.balances(), w.env.supply());
        file(&mut w, &second).unwrap();
        w.assert_only_a_burn(&before, supply, &w.issuer.lock, 2 * AMOUNT);
        assert_eq!(w.env.ledger(&w.issuer.lock).bond_free, BOND - 2 * AMOUNT);
    }

    #[test]
    fn a_rotated_wallet_is_read_at_claim_time() {
        let mut w = world_expiring(30);
        let (holder, old) = (Key::new(40), w.issuer.wallet.pubkey());
        let new = w.env.funded_keypair();
        let new_token = w.env.token_account_of(&new.pubkey(), 0);
        let (to_old, to_old_again) = (
            at_a_point(&w, &holder, &old, 1),
            at_a_point(&w, &holder, &old, 2),
        );
        let (to_new, to_new_again) = (
            at_a_point(&w, &holder, &new.pubkey(), 3),
            at_a_point(&w, &holder, &new.pubkey(), 4),
        );
        let old_token = w.issuer.wallet_token;
        settle_to(&mut w, &to_old, &old_token);

        let key = w.issuer.key.sec1();
        let t = w.env.now() as i64;
        let ixs = vec![
            w.issuer.key.rotation(&old, &new.pubkey(), 0),
            request_only_ix(&key, &new.pubkey(), &old),
        ];
        w.env
            .send_signed(&old, &ixs, &[&w.issuer.wallet, &new])
            .unwrap();
        w.env.warp(t + ROTATION_DELAY as i64);
        w.env
            .send_signed(&new.pubkey(), &[apply_ix(&key, &old)], &[&new])
            .unwrap();

        // The wallet that was the organiser's when the loss happened is no longer its wallet.
        let (before, supply) = (w.balances(), w.env.supply());
        file(&mut w, &to_old_again).unwrap();
        w.assert_only_a_burn(&before, supply, &w.issuer.lock, 2 * AMOUNT);

        // The current wallet is, and its losses burn nothing.
        settle_to(&mut w, &to_new, &new_token);
        let supply = w.env.supply();
        assert_eq!(
            file(&mut w, &to_new_again).unwrap_err(),
            code(1, E::NotClaimable)
        );
        assert_eq!(w.env.supply(), supply);
    }

    #[test]
    fn a_claim_that_names_no_lock_needs_the_owners_device() {
        let mut w = world();
        let (holder, other) = (Key::new(40), w.winner);
        let (first, second) = (
            at_a_point(&w, &holder, &other, 1),
            at_a_point(&w, &holder, &other, 2),
        );
        w.settle(&first).unwrap();
        let key = w.issuer.key.sec1();
        let mut ixs = claim_lost_ixs(&w.payer(), &w.issuer.lock, key, 0, &w.env.mint, &second);
        let device = device_address(&key);
        for meta in &mut ixs[1].accounts {
            if meta.pubkey == device {
                meta.pubkey = buckspay::ID;
            }
        }
        assert_eq!(w.env.submit(&ixs).unwrap_err(), code(1, E::DeviceRequired));
    }
}
