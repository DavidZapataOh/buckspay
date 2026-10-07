//! The attacks on the claim paths as tests that fail when the check they pin is removed, and the
//! rules that bound a claim: who it can blame, what it must be backed by, what it burns, and what
//! a key that holds no stake can and cannot do with a lock.
mod common;
use anchor_lang::prelude::Pubkey;
use buckspay::BuckspayError as E;
use buckspay_protocol::{flags, window, Caveats, Outputs, Owner, Spend, GRACE, NO_LOCK};
use common::claims::*;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

type Sent = Result<Landed, solana_transaction::TransactionError>;

/// A payee that holds an output with no lock of its own and settles it twice, to two accounts.
struct Payee {
    key: Key,
    settled: Chain,
    retried: Chain,
}

fn payee_with_two_settlements(w: &mut World, start: u64) -> Payee {
    let key = Key::new(50);
    let account = Keypair::new();
    let note = || {
        Chain::issue(
            &w.issuer.key,
            &w.env.mint,
            0,
            start,
            AMOUNT,
            key.owner(),
            caveats(w.expiry, 4),
        )
    };
    let settled = note().spend1_to_account(&key, 0, &w.winner, NO_LOCK, 1);
    let retried = note().spend1_to_account(&key, 0, &account.pubkey(), NO_LOCK, 2);
    Payee {
        key,
        settled,
        retried,
    }
}

/// Anyone files `chain` against the issuer's lock, naming `lock_key`.
fn claim_issuer(w: &mut World, lock_key: [u8; 33], chain: &Chain) -> Sent {
    let ixs = claim_lost_ixs(&w.payer(), &w.issuer.lock, lock_key, 0, &w.env.mint, chain);
    w.env.submit(&ixs)
}

#[test]
fn a_payee_without_a_lock_cannot_claim_from_its_payers_bond_after_settling_twice() {
    let mut w = world();
    let payee = payee_with_two_settlements(&mut w, 0);
    w.settle(&payee.settled).unwrap();
    let issuer_key = w.issuer.key.sec1();
    // The second settlement lost the race and nobody accepted it offline: there is no victim, and
    // the issuer's lock, the nearest lock of the chain, is not liable for a plain settlement.
    assert_eq!(
        claim_issuer(&mut w, issuer_key, &payee.retried).unwrap_err(),
        code(1, E::NotClaimable)
    );
    assert_eq!(w.env.ledger(&w.issuer.lock).bond_free, BOND);
    let _ = payee.key;
}

#[test]
fn many_branches_of_a_plain_settlement_cannot_burn_the_payers_bond() {
    let mut w = world();
    let payee = payee_with_two_settlements(&mut w, 0);
    w.settle(&payee.settled).unwrap();
    let issuer_key = w.issuer.key.sec1();
    // Branches are free: every one is one more signature over the same output.
    for salt in 3..8u8 {
        let account = Keypair::new();
        let branch = Chain::issue(
            &w.issuer.key,
            &w.env.mint,
            0,
            0,
            AMOUNT,
            payee.key.owner(),
            caveats(w.expiry, 4),
        )
        .spend1_to_account(&payee.key, 0, &account.pubkey(), NO_LOCK, salt);
        assert_eq!(
            claim_issuer(&mut w, issuer_key, &branch).unwrap_err(),
            code(1, E::NotClaimable)
        );
    }
    assert_eq!(w.env.ledger(&w.issuer.lock).bond_free, BOND);
}

#[test]
fn a_delegates_equivocation_burns_the_delegators_lock_twice_the_note_and_pays_nobody() {
    let mut w = world();
    let delegate = Key::new(40);
    let delegated = |w: &World| {
        Chain::issue(
            &w.issuer.key,
            &w.env.mint,
            0,
            0,
            AMOUNT,
            delegate.owner(),
            Caveats {
                flags: flags::DELEGATED,
                ..caveats(w.expiry, 4)
            },
        )
    };
    let pay = |w: &World, to: Owner, salt: u8| {
        delegated(w).spend(&delegate, 0, |c| Spend {
            input: c.id,
            lock_seq: NO_LOCK,
            salt: [salt; 16],
            outputs: Outputs::One {
                owner: to,
                caveats: Caveats {
                    hops_left: c.caveats.hops_left - 1,
                    flags: 0,
                    ..c.caveats
                },
            },
        })
    };
    let winning = pay(&w, Owner::Account(w.winner.to_bytes()), 1);
    let losing = pay(&w, w.victim.key.owner(), 2);
    w.settle(&winning).unwrap();
    // Naming any other lock is no claim.
    assert_eq!(
        claim_lost_ixs(
            &w.payer(),
            &w.culprit.lock,
            w.culprit.key.sec1(),
            0,
            &w.env.mint,
            &losing
        )
        .len(),
        2
    );
    let wrong = claim_lost_ixs(
        &w.payer(),
        &w.culprit.lock,
        w.culprit.key.sec1(),
        0,
        &w.env.mint,
        &losing,
    );
    assert_eq!(w.env.submit(&wrong).unwrap_err(), code(1, E::ConflictProof));
    let (before, supply) = (w.balances(), w.env.supply());
    let key = w.issuer.key.sec1();
    claim_issuer(&mut w, key, &losing).unwrap();
    // The delegator's bond answers for the delegate, but only for twice what the delegate held,
    // and the delegate, who has no stake, takes nothing from it.
    let ledger = w.env.ledger(&w.issuer.lock);
    assert_eq!(
        (ledger.bond_free, ledger.bond_slashed),
        (BOND - 2 * AMOUNT, 0)
    );
    w.assert_only_a_burn(&before, supply, &w.issuer.lock, 2 * AMOUNT);
}

/// A lock backing 30 and two issues of 20 that overlap by 10.
fn overlapping_issues(days: u32) -> (World, Chain, Chain) {
    let mut w = world_expiring(days);
    w.issuer = w.env.issuer(11, BOND, 30_000_000, 60);
    let holder = Key::new(60);
    let issue = |w: &World, start: u64, to: Owner| {
        Chain::issue(
            &w.issuer.key,
            &w.env.mint,
            0,
            start,
            AMOUNT,
            to,
            caveats(w.expiry, 4),
        )
    };
    let x = issue(&w, 0, holder.owner()).spend1_to_account(&holder, 0, &w.winner, NO_LOCK, 1);
    let y = issue(&w, 10_000_000, w.victim.key.owner());
    w.settle(&x).unwrap();
    assert_eq!(w.env.ledger(&w.issuer.lock).backing_left, 10_000_000);
    (w, x, y)
}

fn claim_unbacked(w: &mut World, chain: &Chain) -> Sent {
    let ixs = claim_unbacked_ixs(&w.payer(), &w.issuer.lock, &w.env.mint, chain);
    w.env.submit(&ixs)
}

#[test]
fn a_losing_branch_of_a_double_spend_is_not_an_over_issuance() {
    // V backs 30 and issues one note of 20 to the culprit, who settles it to its own account and
    // signs the same output to a second key. The second key's chain is unpaid because its sibling
    // was paid out of the same backing, not because the issuer overlapped anything.
    let mut w = world();
    w.issuer = w.env.issuer(11, BOND, 30_000_000, 60);
    let (winning, losing) = (w.winning(0), w.losing(0, 2));
    w.settle(&winning).unwrap();
    assert_eq!(w.env.ledger(&w.issuer.lock).backing_left, 10_000_000);
    assert_eq!(
        claim_unbacked(&mut w, &losing).unwrap_err(),
        code(1, E::NotClaimable)
    );
    assert_eq!(w.env.ledger(&w.issuer.lock).bond_free, BOND);
}

#[test]
fn a_reclaimed_output_is_not_an_over_issuance_either() {
    let mut w = world();
    w.issuer = w.env.issuer(11, BOND, 30_000_000, 60);
    let (base, losing) = (w.base(0), w.losing(0, 2));
    // The holder pays the victim offline, lets the note go unsettled past its grace and takes the
    // output back: the backing falls by it, and the victim's chain is unpaid.
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
    assert_eq!(w.env.ledger(&w.issuer.lock).backing_left, 10_000_000);
    assert_eq!(
        claim_unbacked(&mut w, &losing).unwrap_err(),
        code(1, E::NotClaimable)
    );
    assert_eq!(w.claim(&losing).unwrap_err(), code(1, E::NotClaimable));
}

#[test]
fn an_unpaid_chain_whose_records_agree_with_it_burns_the_issuers_bond_and_nothing_else() {
    let (mut w, _, y) = overlapping_issues(10);
    let (before, supply) = (w.balances(), w.env.supply());
    let landed = claim_unbacked(&mut w, &y).unwrap();
    eprintln!("claim_unbacked: {} CU, {} bytes", landed.units, landed.size);
    let claim = w.env.claim(&y.last.first.id).unwrap();
    assert_eq!((claim.amount, claim.burned), (AMOUNT, 2 * AMOUNT));
    w.assert_only_a_burn(&before, supply, &w.issuer.lock, 2 * AMOUNT);
    // The backing was never touched, and the claim wrote nothing to the output's record: the
    // holder of the output keeps whatever the backing can still pay it.
    assert_eq!(w.env.ledger(&w.issuer.lock).backing_left, 10_000_000);
    assert!(w.env.spent(&y.last.first.id).is_none());
    // Filed again, the same loss is refused and burns nothing more.
    assert_eq!(
        claim_unbacked(&mut w, &y).unwrap_err(),
        code(1, E::AlreadyClaimed)
    );
    assert_eq!(w.env.ledger(&w.issuer.lock).bond_free, BOND - 2 * AMOUNT);
}

#[test]
fn a_claimed_output_can_still_be_settled_in_part_against_what_the_backing_holds() {
    // Nobody is paid out of the bond, so nothing needs the claimed output to be taken back: its
    // holder keeps the right to settle it against the 10 the backing still has.
    let mut w = world_expiring(10);
    w.issuer = w.env.issuer(11, BOND, 30_000_000, 60);
    let holder = Key::new(60);
    let victim = Key::new(12);
    let issue = |w: &World, start: u64, to: Owner| {
        Chain::issue(
            &w.issuer.key,
            &w.env.mint,
            0,
            start,
            AMOUNT,
            to,
            caveats(w.expiry, 4),
        )
    };
    let x = issue(&w, 0, holder.owner()).spend1_to_account(&holder, 0, &w.winner, NO_LOCK, 1);
    let y = issue(&w, 10_000_000, victim.owner());
    w.settle(&x).unwrap();
    claim_unbacked(&mut w, &y).unwrap();
    let split = y.clone().spend2(
        &victim,
        0,
        Owner::Account(w.winner.to_bytes()),
        5_000_000,
        0,
        7,
    );
    w.settle(&split).unwrap();
    assert_eq!(w.env.ledger(&w.issuer.lock).backing_left, 5_000_000);
}

/// A holder that claims an output the backing cannot pay and has already passed it on: the payee's
/// own claim stays open, because a claim writes nothing but itself.
fn unbacked_world() -> (World, Chain, Chain, Chain) {
    let mut w = world();
    // The issuer backs 30 and signs two overlapping notes of 20.
    w.issuer = w.env.issuer(11, BOND, 30_000_000, 60);
    let a = Chain::issue(
        &w.issuer.key,
        &w.env.mint,
        0,
        0,
        AMOUNT,
        w.culprit.key.owner(),
        caveats(w.expiry, 4),
    );
    // The holder passes A on to the payee naming its own lock.
    let to_payee = a.clone().spend(&w.culprit.key, 0, |c| Spend {
        input: c.id,
        lock_seq: 0,
        salt: [7; 16],
        outputs: Outputs::One {
            owner: w.victim.key.owner(),
            caveats: Caveats {
                hops_left: c.caveats.hops_left - 1,
                ..c.caveats
            },
        },
    });
    // The other note, [10, 30), is paid for real: the backing left is 10, below A's 20.
    let other = Key::new(61);
    let b = Chain::issue(
        &w.issuer.key,
        &w.env.mint,
        0,
        10_000_000,
        AMOUNT,
        other.owner(),
        caveats(w.expiry, 4),
    )
    .spend1_to_account(&other, 0, &w.winner, NO_LOCK, 1);
    (w, a, to_payee, b)
}

#[test]
fn a_holder_that_claims_a_bad_note_and_passes_it_on_leaves_its_payee_a_claim() {
    let (mut w, a, to_payee, b) = unbacked_world();
    w.settle(&b).unwrap();
    // The holder files A and the burn lands on the issuer ...
    claim_unbacked(&mut w, &a).unwrap();
    // ... and the payee, who holds A's spend, files its own chain: the claim of A took nothing
    // from it, and the output it holds is another output with its own claim: a claim writes
    // nothing but its own account.
    claim_unbacked(&mut w, &to_payee).unwrap();
    assert_eq!(w.env.ledger(&w.issuer.lock).bond_free, BOND - 4 * AMOUNT);
    assert!(w.env.claim(&a.last.first.id).is_some());
    assert!(w.env.claim(&to_payee.last.first.id).is_some());
}

#[test]
fn the_payee_of_a_holder_that_claimed_and_passed_on_claims_the_issuer_without_the_holders_claim() {
    // The control: without the holder's claim the payee's claim lands the same.
    let (mut w, _, to_payee, b) = unbacked_world();
    w.settle(&b).unwrap();
    claim_unbacked(&mut w, &to_payee).unwrap();
    assert_eq!(w.env.ledger(&w.issuer.lock).bond_free, BOND - 2 * AMOUNT);
}

#[test]
#[cfg(not(feature = "short-windows"))] // the windows are days long
fn an_unbacked_claim_ends_with_the_lock_and_with_the_challenge() {
    // The challenge of a note that expires in 10 days ends long before the lock does.
    let (mut w, _, y) = overlapping_issues(10);
    w.env
        .warp(i64::from(window::report_deadline(w.expiry) as u32) + 1);
    assert_eq!(
        claim_unbacked(&mut w, &y).unwrap_err(),
        code(1, E::ClaimTooLate)
    );
    // A note that expires so late that its challenge outlasts the lock is closed by the lock.
    for (offset, ok) in [(-1, true), (0, false)] {
        let (mut w, _, y) = overlapping_issues(50);
        assert!(window::report_deadline(w.expiry) > u64::from(w.issuer.lock_until));
        w.env.warp(i64::from(w.issuer.lock_until) + offset);
        let result = claim_unbacked(&mut w, &y);
        if ok {
            result.unwrap();
        } else {
            assert_eq!(result.unwrap_err(), code(1, E::LockEnded));
        }
    }
}

#[test]
#[cfg(not(feature = "short-windows"))] // the windows are days long
fn a_lock_that_ends_with_the_challenge_leaves_its_last_second_unclaimable() {
    // `lock_until == expiry + GRACE + CHALLENGE`: the claim deadline is the last second the lock
    // lives in, and claims end at `lock_until`. Receivers refuse such a ticket (01-02: the lock
    // must outlast the window by a second), so no payment can depend on it.
    let mut w = world_expiring(46);
    assert_eq!(
        window::report_deadline(w.expiry),
        u64::from(w.culprit.lock_until)
    );
    let (winning, losing) = (w.winning(0), w.losing(0, 2));
    w.settle(&winning).unwrap();
    w.env.warp(i64::from(w.culprit.lock_until));
    assert_eq!(w.claim(&losing).unwrap_err(), code(1, E::LockEnded));
}

#[test]
fn a_claim_on_a_lock_of_another_mint_is_refused() {
    let w = world();
    let foreign = Pubkey::new_from_array([9; 32]);
    let chain = Chain::issue(
        &w.issuer.key,
        &foreign,
        0,
        0,
        AMOUNT,
        w.culprit.key.owner(),
        caveats(w.expiry, 4),
    )
    .spend(&w.culprit.key, 0, |c| Spend {
        input: c.id,
        lock_seq: 0,
        salt: [2; 16],
        outputs: Outputs::One {
            owner: w.victim.key.owner(),
            caveats: Caveats {
                hops_left: c.caveats.hops_left - 1,
                ..c.caveats
            },
        },
    });
    let mut w = w;
    assert_eq!(w.claim(&chain).unwrap_err(), code(1, E::WrongLock));
}

#[test]
fn an_output_above_the_payment_limit_of_the_lock_is_no_loss_of_it() {
    let mut w = world();
    let big = LIMIT + 1;
    let (winning, losing) = (w.winning_of(0, big), w.losing_of(0, 2, big));
    w.settle(&winning).unwrap();
    assert_eq!(w.claim(&losing).unwrap_err(), code(1, E::OverCoverage));
    // One unit less is covered.
    let mut w = world();
    let (winning, losing) = (w.winning_of(0, LIMIT), w.losing_of(0, 2, LIMIT));
    w.settle(&winning).unwrap();
    w.claim(&losing).unwrap();

    // The same for an over-issuance: an issue the bond does not cover was refused by receivers.
    let mut w = world();
    w.issuer = w.env.issuer(11, BOND, 40_000_000, 60);
    let holder = Key::new(60);
    let issue = |w: &World, start: u64, amount: u64, to: Owner| {
        Chain::issue(
            &w.issuer.key,
            &w.env.mint,
            0,
            start,
            amount,
            to,
            caveats(w.expiry, 4),
        )
    };
    let x = issue(&w, 0, big, holder.owner()).spend1_to_account(&holder, 0, &w.winner, NO_LOCK, 1);
    let y = issue(&w, 10_000_000, big, w.victim.key.owner());
    w.settle(&x).unwrap();
    assert_eq!(
        claim_unbacked(&mut w, &y).unwrap_err(),
        code(1, E::OverCoverage)
    );
}

#[test]
fn an_account_that_holds_an_unbacked_chain_claims_it_and_a_chain_that_was_paid_is_not_claimed() {
    let mut w = world();
    w.issuer = w.env.issuer(11, BOND, 30_000_000, 60);
    let holder = Key::new(60);
    let account = Keypair::new();
    let issue = |w: &World, start: u64, to: Owner| {
        Chain::issue(
            &w.issuer.key,
            &w.env.mint,
            0,
            start,
            AMOUNT,
            to,
            caveats(w.expiry, 4),
        )
    };
    let x = issue(&w, 0, holder.owner()).spend1_to_account(&holder, 0, &w.winner, NO_LOCK, 1);
    w.settle(&x).unwrap();
    // An account holds the output of an issue the backing cannot pay: its chain is claimed.
    let unpaid = issue(&w, 10_000_000, Owner::Account(account.pubkey().to_bytes()));
    claim_unbacked(&mut w, &unpaid).unwrap();
    assert_eq!(w.env.claim(&unpaid.last.first.id).unwrap().amount, AMOUNT);

    // A chain that was settled has been paid whatever the backing says afterwards.
    let mut w = world();
    w.issuer = w.env.issuer(11, BOND, 30_000_000, 60);
    let paid = issue(&w, 10_000_000, holder.owner()).spend1_to_account(
        &holder,
        0,
        &account.pubkey(),
        NO_LOCK,
        2,
    );
    let token = w.env.token_account_of(&account.pubkey(), 0);
    let ixs = settle_ixs(&w.env, &w.payer(), &w.issuer, &paid, &token);
    w.env.submit(&ixs).unwrap();
    assert_eq!(w.env.ledger(&w.issuer.lock).backing_left, 10_000_000);
    assert_eq!(
        claim_unbacked(&mut w, &paid).unwrap_err(),
        code(1, E::NotClaimable)
    );
}

#[test]
fn a_chain_nobody_settled_burns_nothing() {
    // Only a claim with a record burns: a made-up slot or output slashes nothing.
    let mut w = world();
    let losing = w.losing(0, 2);
    assert_eq!(w.claim(&losing).unwrap_err(), code(1, E::NoRecord));
    assert_eq!(w.env.ledger(&w.culprit.lock).bond_free, BOND);
}

#[test]
fn a_chain_the_backing_can_pay_is_no_loss() {
    let mut w = world();
    w.issuer = w.env.issuer(11, BOND, 60_000_000, 60);
    let chain = Chain::issue(
        &w.issuer.key,
        &w.env.mint,
        0,
        10_000_000,
        AMOUNT,
        w.victim.key.owner(),
        caveats(w.expiry, 4),
    );
    assert_eq!(
        claim_unbacked(&mut w, &chain).unwrap_err(),
        code(1, E::NotClaimable)
    );
    assert_eq!(w.env.ledger(&w.issuer.lock).bond_free, BOND);
}

#[test]
fn an_unbacked_claim_needs_an_issue_inside_the_backing_and_on_the_locks_mint() {
    let (mut w, _, _) = overlapping_issues(10);
    let issue = |w: &World, mint: &Pubkey, start: u64| {
        Chain::issue(
            &w.issuer.key,
            mint,
            0,
            start,
            AMOUNT,
            w.victim.key.owner(),
            caveats(w.expiry, 4),
        )
    };
    // The lock backs 30: an interval ending at 40 is not backed by it.
    let mint = w.env.mint;
    let beyond = issue(&w, &mint, 20_000_000);
    assert_eq!(
        claim_unbacked(&mut w, &beyond).unwrap_err(),
        code(1, E::WrongLock)
    );
    // Inside the backing, on another mint.
    let foreign = issue(&w, &Pubkey::new_from_array([9; 32]), 10_000_000);
    assert_eq!(
        claim_unbacked(&mut w, &foreign).unwrap_err(),
        code(1, E::WrongLock)
    );
}

// Attacks on the burn, as the tests that pin their answer.

fn funded(w: &mut World) -> (Keypair, Pubkey) {
    let account = Keypair::new();
    w.env.svm.airdrop(&account.pubkey(), 1_000_000_000).unwrap();
    let token = w.env.token_account_of(&account.pubkey(), 0);
    (account, token)
}

/// Whoever holds the device key of a lock (malware on a rooted phone) signs an issue of its own, a
/// spend to an account and two spends to accounts of its own, and files them: no note, no victim
/// and no backing is needed. The bond burns and the attacker is paid nothing.
#[test]
fn a_key_holder_with_no_note_can_burn_the_bond_and_is_paid_nothing() {
    let mut w = world();
    let d = w.env.issuer(7, BOND, 1_000_000_000, 60);
    let (x1, t1) = funded(&mut w);
    let (x2, t2) = funded(&mut w);
    let thief = Pubkey::new_unique();
    let base = Chain::issue(
        &d.key,
        &w.env.mint,
        0,
        0,
        LIMIT,
        d.key.owner(),
        caveats(w.expiry, 4),
    );
    let a = base.clone().spend1_to_account(&d.key, 0, &thief, 0, 1);
    let b1 = base
        .clone()
        .spend1_to_account(&d.key, 0, &x1.pubkey(), 0, 2);
    let b2 = base
        .clone()
        .spend1_to_account(&d.key, 0, &x2.pubkey(), 0, 3);
    let payer = w.payer();
    let before = w.env.ledger(&d.lock);
    w.env.submit(&record_prefix_ixs(&payer, &d, &a, 0)).unwrap();
    let supply = w.env.supply();
    for (chain, filer) in [(&b1, &x1), (&b2, &x2)] {
        let ixs = claim_lost_ixs(
            &filer.pubkey(),
            &d.lock,
            d.key.sec1(),
            0,
            &w.env.mint,
            chain,
        );
        w.env.send(filer, &ixs).unwrap();
    }
    let ledger = w.env.ledger(&d.lock);
    assert_eq!(
        ledger.backing_left, before.backing_left,
        "no backing was spent"
    );
    // The most the key holder can do to the bond: burn it, for the price of its float.
    assert_eq!((ledger.bond_free, ledger.bond_slashed), (0, 0));
    assert_eq!(supply - w.env.supply(), BOND);
    // And it is paid nothing: its accounts hold nothing, and neither does any other.
    assert_eq!(w.env.balance(&t1) + w.env.balance(&t2), 0);
    assert_eq!(w.env.balance(&escrow_address(&d.lock)), 1_000_000_000);
}

/// The same with notes a fifth of the payment limit: made-up issues are free, so only the bond
/// bounds what a key holder can burn.
#[test]
fn five_made_up_notes_of_five_burn_the_whole_bond_and_nothing_is_paid() {
    let mut w = world();
    let d = w.env.issuer(7, BOND, 1_000_000_000, 60);
    let (x1, t1) = funded(&mut w);
    let thief = Pubkey::new_unique();
    let payer = w.payer();
    let note = 5_000_000;
    for k in 0..10u64 {
        let base = Chain::issue(
            &d.key,
            &w.env.mint,
            0,
            k * note,
            note,
            d.key.owner(),
            caveats(w.expiry, 4),
        );
        let a = base.clone().spend1_to_account(&d.key, 0, &thief, 0, 1);
        w.env.submit(&record_prefix_ixs(&payer, &d, &a, 0)).unwrap();
        let b = base
            .clone()
            .spend1_to_account(&d.key, 0, &x1.pubkey(), 0, 2);
        let ixs = claim_lost_ixs(&payer, &d.lock, d.key.sec1(), 0, &w.env.mint, &b);
        w.env.submit(&ixs).unwrap();
    }
    let ledger = w.env.ledger(&d.lock);
    assert_eq!(ledger.bond_free, 0);
    assert_eq!(w.env.balance(&t1), 0);
}

/// A device key with three locks double spends one note to two victims of each lock, each within
/// that lock's exposure. Every lock answers for its own victims, so the culprit nets a loss.
fn extra_lock(w: &mut World, seq: u32) -> Pubkey {
    use anchor_lang::{InstructionData, ToAccountMetas};
    let key = w.culprit.key.sec1();
    let lock = lock_address(&key, seq);
    let funder = w
        .env
        .token_account_of(&w.culprit.wallet.pubkey(), BOND + 10_000_000);
    let create = anchor_lang::solana_program::instruction::Instruction {
        program_id: buckspay::ID,
        accounts: buckspay::accounts::CreateLock {
            wallet: w.culprit.wallet.pubkey(),
            payer: w.culprit.wallet.pubkey(),
            device: device_address(&key),
            lock,
            ledger: ledger_address(&lock),
            escrow: escrow_address(&lock),
            mint: w.env.mint,
            funder,
            sponsor_token: None,
            token_program: token_id(),
            system_program: solana_sdk_ids::system_program::ID,
        }
        .to_account_metas(None),
        data: buckspay::instruction::CreateLock {
            args: buckspay::CreateLockArgs {
                key,
                lock_seq: seq,
                bond: BOND,
                backing: 10_000_000,
                lock_until: w.culprit.lock_until,
                sponsor_fee: 0,
            },
        }
        .data(),
    };
    let wallet = w.culprit.wallet.insecure_clone();
    w.env.send(&wallet, &[create]).unwrap();
    lock
}

#[test]
fn one_note_two_extra_locks_every_lock_answers_for_its_own_victims() {
    let mut w = world();
    let locks = [w.culprit.lock, extra_lock(&mut w, 1), extra_lock(&mut w, 2)];
    let winning = w.winning(0);
    w.settle(&winning).unwrap();
    let key = w.culprit.key.sec1();
    let mut stolen = 0u64;
    for (seq, lock) in locks.iter().enumerate() {
        for k in 0..2u8 {
            let victim = w.env.actor(30 + 2 * seq as u8 + k);
            let chain = w.base(0).spend(&w.culprit.key, 0, |c| Spend {
                input: c.id,
                lock_seq: seq as u32,
                salt: [10 + 2 * seq as u8 + k; 16],
                outputs: Outputs::One {
                    owner: victim.key.owner(),
                    caveats: Caveats {
                        hops_left: c.caveats.hops_left - 1,
                        ..c.caveats
                    },
                },
            });
            stolen += AMOUNT;
            let ixs = claim_lost_ixs(&w.payer(), lock, key, seq as u32, &w.env.mint, &chain);
            w.env
                .submit(&ixs)
                .unwrap_or_else(|e| panic!("lock {seq} victim {k}: {e:?}"));
        }
    }
    let burned: u64 = locks.iter().map(|l| BOND - w.env.ledger(l).bond_free).sum();
    eprintln!(
        "3 locks of {BOND} each, 2 victims of {AMOUNT} each: stolen {stolen}, burned {burned}, culprit net {}",
        stolen as i64 - burned as i64
    );
    // Each lock burned twice what its two victims lost: 80 of 100, the sum is twice the theft.
    for lock in &locks {
        assert_eq!(w.env.ledger(lock).bond_free, BOND - 4 * AMOUNT);
    }
    assert_eq!(burned, 2 * stolen);
    assert!(stolen < burned);
}

/// The culprit files claims of accounts of its own against the contested output before the real
/// victim does. There is no cap per output to fill, and the claims of the culprit only add to what
/// burns.
#[test]
fn the_culprits_own_claims_cannot_shut_the_real_victim_out_or_lower_the_burn() {
    let mut w = world();
    let winning = w.winning(0);
    w.settle(&winning).unwrap();
    let (x1, _) = funded(&mut w);
    let (x2, _) = funded(&mut w);
    let lock = w.culprit.lock;
    let key = w.culprit.key.sec1();
    for (salt, x) in [(2u8, &x1), (3u8, &x2)] {
        let b = w
            .base(0)
            .spend1_to_account(&w.culprit.key, 0, &x.pubkey(), 0, salt);
        let ixs = claim_lost_ixs(&x.pubkey(), &lock, key, 0, &w.env.mint, &b);
        w.env.send(x, &ixs).unwrap();
    }
    // Two claims of 20 burned 40 each, the real victim's third finds the 20 that are left.
    let losing = w.losing(0, 9);
    w.claim(&losing).unwrap();
    let claim = w.env.claim(&losing.last.first.id).unwrap();
    assert_eq!((claim.amount, claim.burned), (AMOUNT, BOND - 4 * AMOUNT));
    assert_eq!(w.env.ledger(&lock).bond_free, 0);
}

/// The culprit grinds the salt of the payment it signs so that a search for the claim
/// address costs the victim compute units. Claim addresses have a fixed bump now: the cost of a
/// claim does not depend on the output, and an output that cannot be claimed is refused to its
/// signer by the guard and to its payee by every receiver.
#[test]
fn a_ground_payment_id_cannot_make_a_claim_expensive() {
    let mut units = vec![];
    for salt in 2u8..12 {
        let mut w = world();
        let (winning, losing) = (w.winning(0), w.losing(0, salt));
        w.settle(&winning).unwrap();
        units.push(w.claim(&losing).unwrap().units);
    }
    let (min, max) = (units.iter().min().unwrap(), units.iter().max().unwrap());
    eprintln!("claim_lost_spend over ten payment ids: {min} to {max} CU");
    assert!(max - min <= 100, "{units:?}");
}

#[test]
fn the_program_has_no_instruction_that_pays_a_claimant() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let lib = std::fs::read_to_string(src.join("lib.rs")).unwrap();
    let instructions: Vec<&str> = lib
        .lines()
        .filter_map(|l| l.strip_prefix("    pub fn "))
        .map(|l| l.split(['(', '<']).next().unwrap())
        .collect();
    assert_eq!(
        instructions,
        [
            "register_device",
            "migrate_device",
            "create_lock",
            "withdraw_lock",
            "release_lock",
            "close_lock",
            "request_wallet_rotation",
            "cancel_wallet_rotation",
            "apply_wallet_rotation",
            "settle_note",
            "settle_chain_proof",
            "open_proof_buffer",
            "write_proof_buffer",
            "close_proof_buffer",
            "init_zk_config",
            "set_zk_paused",
            "set_zk_mint",
            "rotate_vk",
            "revoke_previous_vk",
            "set_zk_authorities",
            "reclaim_output",
            "record_prefix",
            "close_spent",
            "claim_lost_spend",
            "claim_unbacked",
            "close_records",
            "register_attester",
            "top_up_attester",
            "rotate_attester_key",
            "request_attester_exit",
            "cancel_attester_exit",
            "withdraw_attester_stake",
            "settle_channel",
            "close_channel",
            "init_reward_config",
            "set_rewards_paused",
            "init_reward_mint",
            "set_reward_policy",
            "rotate_reward_tree",
            "report_false_ticket",
        ]
    );
    // The claim path moves tokens only through the burn, and so does the report of a false ticket:
    // what an attester stakes is destroyed, never paid to the reporter or to a victim.
    for name in [
        "claim_lost_spend.rs",
        "claim_unbacked.rs",
        "report_false_ticket.rs",
        "filing.rs",
        "burn.rs",
    ] {
        let text = std::fs::read_to_string(
            src.join(if name.starts_with("filing") || name.starts_with("burn") {
                ""
            } else {
                "instructions"
            })
            .join(name),
        )
        .unwrap();
        assert!(!text.contains("pay_out"), "{name} pays out");
        assert!(!text.to_lowercase().contains("reward"), "{name} rewards");
    }
}

/// An issue the bond does not cover was refused by every receiver, even when what its holder
/// ended up with is small: the claim is covered by the issue, not by the output it split into.
#[test]
fn an_unbacked_claim_is_covered_by_its_issue_and_not_by_the_part_of_it_that_is_left() {
    let mut w = world();
    w.issuer = w.env.issuer(11, BOND, 40_000_000, 60);
    let (x_holder, y_holder) = (Key::new(60), Key::new(62));
    let big = LIMIT + 1_000_000;
    let issue = |w: &World, start: u64, to: Owner| {
        Chain::issue(
            &w.issuer.key,
            &w.env.mint,
            0,
            start,
            big,
            to,
            caveats(w.expiry, 4),
        )
    };
    let x = issue(&w, 0, x_holder.owner()).spend1_to_account(&x_holder, 0, &w.winner, NO_LOCK, 1);
    w.settle(&x).unwrap();
    assert_eq!(w.env.ledger(&w.issuer.lock).backing_left, 14_000_000);
    // The second issue overlaps the first by 12; its holder pays 20 of the 26 to the victim, a
    // payment the bond would cover and the backing cannot pay.
    let y = issue(&w, 14_000_000, y_holder.owner()).spend2(
        &y_holder,
        0,
        w.victim.key.owner(),
        20_000_000,
        0,
        7,
    );
    assert!(y.last.first.amount <= LIMIT && y.last.first.amount > 14_000_000);
    assert_eq!(
        claim_unbacked(&mut w, &y).unwrap_err(),
        code(1, E::OverCoverage)
    );
    assert_eq!(w.env.ledger(&w.issuer.lock).bond_free, BOND);
}

/// The deadline of an account-held chain is the one of the output its last spend consumed,
/// not of the output the spend made, which a spender can narrow.
#[test]
fn an_unbacked_claim_by_an_account_has_the_deadline_of_the_output_its_chain_consumed() {
    for (offset, ok) in [(0i64, true), (1, false)] {
        let (mut w, _, _) = overlapping_issues(10);
        let holder = Key::new(62);
        let account = Keypair::new();
        let y = Chain::issue(
            &w.issuer.key,
            &w.env.mint,
            0,
            10_000_000,
            AMOUNT,
            holder.owner(),
            caveats(w.expiry, 4),
        )
        .spend(&holder, 0, |c| Spend {
            input: c.id,
            lock_seq: NO_LOCK,
            salt: [5; 16],
            outputs: Outputs::One {
                owner: Owner::Account(account.pubkey().to_bytes()),
                caveats: Caveats {
                    hops_left: c.caveats.hops_left - 1,
                    expiry: c.caveats.expiry - 3 * DAY,
                    ..c.caveats
                },
            },
        });
        let deadline = window::report_deadline(w.expiry) as u32;
        assert!(u64::from(deadline) > window::report_deadline(y.last.first.caveats.expiry));
        w.env.warp(i64::from(deadline) + offset);
        let result = claim_unbacked(&mut w, &y);
        if ok {
            result.unwrap();
        } else {
            assert_eq!(result.unwrap_err(), code(1, E::ClaimTooLate));
        }
    }
}

/// An unbacked claim names one record for each output its chain consumed.
#[test]
fn an_unbacked_claim_names_one_record_per_consumed_output() {
    let (mut w, _, to_payee, b) = unbacked_world();
    w.settle(&b).unwrap();
    let payer = w.payer();
    let ixs = claim_unbacked_ixs(&payer, &w.issuer.lock, &w.env.mint, &to_payee);
    let records = ixs[1].accounts.len() - 10;
    assert_eq!(records, 1);
    let mut fewer = ixs.clone();
    fewer[1].accounts.pop();
    assert_eq!(
        w.env.submit(&fewer).unwrap_err(),
        code(1, E::RecordAccounts)
    );
    let mut more = ixs.clone();
    let last = more[1].accounts[ixs[1].accounts.len() - 1].clone();
    more[1].accounts.push(last);
    assert_eq!(w.env.submit(&more).unwrap_err(), code(1, E::RecordAccounts));
    w.env.submit(&ixs).unwrap();
}

/// The burn leaves the escrow short of what the ledger owes: refused, nothing burns.
#[test]
fn a_burn_from_an_escrow_that_no_longer_covers_the_ledger_is_refused() {
    let (mut w, _, losing) = {
        let mut w = world();
        let (winning, losing) = (w.winning(0), w.losing(0, 2));
        w.settle(&winning).unwrap();
        (w, winning, losing)
    };
    let escrow = escrow_address(&w.culprit.lock);
    let ledger = w.env.ledger(&w.culprit.lock);
    let reserved = ledger.backing_left + ledger.bond_free;
    let mut account = w.env.svm.get_account(&escrow).unwrap();
    account.data[64..72].copy_from_slice(&(reserved - 1).to_le_bytes());
    w.env.svm.set_account(escrow, account).unwrap();
    let supply = w.env.supply();
    assert_eq!(
        w.claim(&losing).unwrap_err(),
        code(1, E::InsufficientEscrow)
    );
    assert_eq!(w.env.supply(), supply);
    assert_eq!(w.env.ledger(&w.culprit.lock).bond_free, BOND);
}

/// The claim is for the payment, not for the output it was paid out of: a culprit that splits an
/// output pays one victim 15 of 20, and the loss is 15.
#[test]
fn a_claim_is_for_the_payment_and_not_for_the_output_it_came_from() {
    let mut w = world();
    let winning = w.winning(0);
    w.settle(&winning).unwrap();
    let losing = w
        .base(0)
        .spend2(&w.culprit.key, 0, w.victim.key.owner(), 15_000_000, 0, 2);
    w.claim(&losing).unwrap();
    let claim = w.env.claim(&losing.last.first.id).unwrap();
    assert_eq!((claim.amount, claim.burned), (15_000_000, 30_000_000));
}

/// A claim made at an account that is not the output's claim address is refused for it, whatever
/// else the instruction would do with the account.
#[test]
fn a_claim_must_be_made_at_the_address_of_its_output() {
    let (mut w, _, losing) = {
        let mut w = world();
        let (winning, losing) = (w.winning(0), w.losing(0, 2));
        w.settle(&winning).unwrap();
        (w, winning, losing)
    };
    let mut ixs = claim_lost_ixs(
        &w.payer(),
        &w.culprit.lock,
        w.culprit.key.sec1(),
        0,
        &w.env.mint,
        &losing,
    );
    let right = claim_address(&losing.last.first.id);
    for meta in &mut ixs[1].accounts {
        if meta.pubkey == right {
            meta.pubkey = Pubkey::new_unique();
        }
    }
    assert_eq!(w.env.submit(&ixs).unwrap_err(), code(1, E::RecordAccounts));
}

/// The coverage of a lost spend is the output the culprit consumed, not the part of it it paid.
#[test]
fn a_split_of_an_output_above_the_payment_limit_is_no_loss_of_the_lock_either() {
    let mut w = world();
    let big = LIMIT + 1_000_000;
    let winning = w.winning_of(0, big);
    w.settle(&winning).unwrap();
    let losing =
        w.base_of(0, big)
            .spend2(&w.culprit.key, 0, w.victim.key.owner(), 10_000_000, 0, 2);
    assert!(losing.last.first.amount <= LIMIT);
    assert_eq!(w.claim(&losing).unwrap_err(), code(1, E::OverCoverage));
    assert_eq!(w.env.ledger(&w.culprit.lock).bond_free, BOND);
}

/// An unbacked claim proves the chain with every signature of it, not with the last alone.
#[test]
fn an_unbacked_claim_needs_every_signature_of_the_chain() {
    let (mut w, _, to_payee, b) = unbacked_world();
    w.settle(&b).unwrap();
    let mut ixs = claim_unbacked_ixs(&w.payer(), &w.issuer.lock, &w.env.mint, &to_payee);
    let last = to_payee.signed.last().unwrap();
    ixs[0] = precompile_ix(&[(last.key, last.envelope)], &[last.signature]);
    assert_eq!(
        w.env.submit(&ixs).unwrap_err(),
        code(1, E::ChainVerification)
    );
    assert_eq!(w.env.ledger(&w.issuer.lock).bond_free, BOND);
}

/// A backing that can pay the output exactly leaves nobody with a loss.
#[test]
fn a_chain_the_backing_can_pay_exactly_is_no_loss() {
    let mut w = world();
    w.issuer = w.env.issuer(11, BOND, 40_000_000, 60);
    let (x_holder, y_holder) = (Key::new(60), Key::new(62));
    let issue = |w: &World, start: u64, to: Owner| {
        Chain::issue(
            &w.issuer.key,
            &w.env.mint,
            0,
            start,
            AMOUNT,
            to,
            caveats(w.expiry, 4),
        )
    };
    let x = issue(&w, 0, x_holder.owner()).spend1_to_account(&x_holder, 0, &w.winner, NO_LOCK, 1);
    w.settle(&x).unwrap();
    // The backing left is 20, and the overlapping issue is of 20: it can still be paid.
    let y = issue(&w, 10_000_000, y_holder.owner());
    assert_eq!(w.env.ledger(&w.issuer.lock).backing_left, AMOUNT);
    assert_eq!(
        claim_unbacked(&mut w, &y).unwrap_err(),
        code(1, E::NotClaimable)
    );
}

/// A device-held output somebody already spent is no loss of the holder's: the claim of the chain
/// that ends there is refused, however the spend was recorded.
#[test]
fn an_unbacked_claim_of_an_output_its_holder_already_spent_is_refused() {
    let (mut w, _, to_payee, b) = unbacked_world();
    w.settle(&b).unwrap();
    let onward = to_payee
        .clone()
        .spend1_to_account(&w.victim.key, 0, &w.winner, NO_LOCK, 9);
    let payer = w.payer();
    let issuer = &w.issuer;
    w.env
        .submit(&record_prefix_ixs(&payer, issuer, &onward, 0))
        .unwrap();
    assert!(w.env.spent(&to_payee.last.first.id).is_some());
    assert_eq!(
        claim_unbacked(&mut w, &to_payee).unwrap_err(),
        code(1, E::NotClaimable)
    );
}
