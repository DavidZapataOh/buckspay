//! Reclaim and the windows around it: every refusal has a test, and the windows are tested at the
//! second on both sides.
mod common;
use anchor_lang::prelude::Pubkey;
use buckspay::{
    records::{PAID, RECLAIMED},
    BuckspayError as E,
};
use buckspay_protocol::{
    lock::RECORD_TTL,
    reclaim::{reclaim_envelope, record_content},
    window, Caveats, Outputs, Owner, Spend, GRACE, NO_LOCK,
};
use common::*;
use solana_signer::Signer;
use solana_transaction::{InstructionError, TransactionError};

const AMOUNT: u64 = 50_000_000;
const BACKING: u64 = 1_000_000_000;

struct W {
    env: Env,
    issuer: Issuer,
    /// The owner of the issues: a registered device of another wallet.
    holder: Issuer,
    /// Another registered device, for the attacks and the second hop.
    other: Issuer,
    payee: Pubkey,
    payee_token: Pubkey,
    expiry: u32,
}

fn world_with(expiry_days: u32) -> W {
    let mut env = Env::new(TokenKind::Classic);
    let issuer = env.issuer(1, 100_000_000, BACKING, 60);
    let holder = env.issuer(2, 1_000_000, 10_000_000, 60);
    let other = env.issuer(3, 1_000_000, 10_000_000, 60);
    let payee = Pubkey::new_unique();
    let payee_token = env.token_account_of(&payee, 0);
    let expiry = expiry_of(&env, expiry_days);
    W {
        env,
        issuer,
        holder,
        other,
        payee,
        payee_token,
        expiry,
    }
}

fn world() -> W {
    world_with(10)
}

#[derive(Clone, Copy)]
enum Who {
    Holder,
    Other,
}

fn anchor_constraint(err: &TransactionError, ix: u8) -> bool {
    matches!(err, TransactionError::InstructionError(i, InstructionError::Custom(c))
        if *i == ix && (2000..3000).contains(c))
}

impl W {
    /// The `n`-th issue of the lock, worth `AMOUNT`, owned by `holder`.
    fn issue_n(&self, n: u64) -> Chain {
        Chain::issue(
            &self.issuer.key,
            &self.env.mint,
            0,
            n * AMOUNT,
            AMOUNT,
            self.holder.key.owner(),
            caveats(self.expiry, 6),
        )
    }
    fn issue(&self) -> Chain {
        self.issue_n(0)
    }
    fn at(&mut self, unix: i64) {
        self.env.warp(unix);
        self.env.svm.expire_blockhash();
    }
    fn after_settlement_window(&mut self) {
        self.at(i64::from(self.expiry) + i64::from(GRACE) + 1);
    }
    fn reclaim(&mut self, chain: &Chain, which: u8, who: Who) -> Result<Landed, TransactionError> {
        let payer = self.env.payer.pubkey();
        let owner = match who {
            Who::Holder => &self.holder,
            Who::Other => &self.other,
        };
        let ixs = reclaim_ixs(
            &self.env,
            &payer,
            &self.issuer,
            chain,
            which,
            &owner.key,
            &owner.wallet_token,
        );
        self.env.submit(&ixs)
    }
    fn settle(&mut self, chain: &Chain) -> Result<Landed, TransactionError> {
        let payer = self.env.payer.pubkey();
        let ixs = settle_ixs(&self.env, &payer, &self.issuer, chain, &self.payee_token);
        self.env.submit(&ixs)
    }
}

#[test]
fn a_reclaim_pays_the_wallet_of_the_owner_and_records_it() {
    let mut w = world();
    let chain = w.issue();
    w.after_settlement_window();
    let landed = w.reclaim(&chain, 0, Who::Holder).unwrap();
    eprintln!("reclaim: {} CU, {} bytes", landed.units, landed.size);
    assert_eq!(w.env.balance(&w.holder.wallet_token), AMOUNT);
    let record = w.env.spent(&chain_first_output(&chain).id).unwrap();
    assert_eq!(
        (record.flags, record.content),
        (PAID | RECLAIMED, record_content())
    );
    assert_eq!(
        u64::from(record.closable_at),
        window::closable_at(w.expiry, w.issuer.lock_until)
    );
}

#[test]
fn a_reclaim_without_the_owners_signature_is_refused() {
    let mut w = world();
    let chain = w.issue();
    w.after_settlement_window();
    let payer = w.env.payer.pubkey();
    let mut ixs = reclaim_ixs(
        &w.env,
        &payer,
        &w.issuer,
        &chain,
        0,
        &w.holder.key,
        &w.holder.wallet_token,
    );
    let signatures: Vec<[u8; 64]> = chain.signed.iter().map(|s| s.signature).collect();
    ixs[0] = precompile_ix(&chain.entries(), &signatures);
    assert_eq!(
        w.env.submit(&ixs).unwrap_err(),
        code(1, E::ChainVerification)
    );
    assert_eq!(w.env.balance(&w.holder.wallet_token), 0);
}

#[test]
fn a_signature_over_another_output_or_deadline_or_domain_is_refused() {
    let mut w = world();
    let chain = w.issue();
    let other_issue = w.issue_n(1);
    w.after_settlement_window();
    let payer = w.env.payer.pubkey();
    let signed_with = |envelope: [u8; 96], w: &W| {
        let mut ixs = reclaim_ixs(
            &w.env,
            &payer,
            &w.issuer,
            &chain,
            0,
            &w.holder.key,
            &w.holder.wallet_token,
        );
        let mut entries = chain.entries();
        let mut signatures: Vec<[u8; 64]> = chain.signed.iter().map(|s| s.signature).collect();
        entries.push((w.holder.key.sec1(), envelope));
        signatures.push(w.holder.key.sign(&envelope));
        ixs[0] = precompile_ix(&entries, &signatures);
        ixs
    };
    let output = chain_first_output(&chain).id;
    let domain = buckspay::reclaim_domain();
    // The deadline in the instruction is u32::MAX; the signature covers another one.
    let ixs = signed_with(reclaim_envelope(&domain, &output, 5), &w);
    assert_eq!(
        w.env.submit(&ixs).unwrap_err(),
        code(1, E::ChainVerification)
    );
    // The signature covers another output.
    let ixs = signed_with(
        reclaim_envelope(&domain, &chain_first_output(&other_issue).id, u32::MAX),
        &w,
    );
    assert_eq!(
        w.env.submit(&ixs).unwrap_err(),
        code(1, E::ChainVerification)
    );
    // The signature is a note-purpose message over the same slot and content.
    let mut note_purpose = reclaim_envelope(&domain, &output, u32::MAX);
    note_purpose[..32].copy_from_slice(&buckspay::note_domain());
    let ixs = signed_with(note_purpose, &w);
    assert_eq!(
        w.env.submit(&ixs).unwrap_err(),
        code(1, E::ChainVerification)
    );
    assert_eq!(w.env.balance(&w.holder.wallet_token), 0);
}

#[test]
fn only_the_owner_of_the_output_can_reclaim_it() {
    let mut w = world();
    let chain = w.issue();
    w.after_settlement_window();
    let payer = w.env.payer.pubkey();
    // Another registered device signs its own reclaim of somebody else's output.
    let ixs = reclaim_ixs(
        &w.env,
        &payer,
        &w.issuer,
        &chain,
        0,
        &w.other.key,
        &w.other.wallet_token,
    );
    assert_eq!(w.env.submit(&ixs).unwrap_err(), code(1, E::ChainInvalid));
    assert_eq!(w.env.balance(&w.other.wallet_token), 0);
    // The owner's key named, the signature made by another key: the precompile refuses it.
    let mut forged = reclaim_ixs(
        &w.env,
        &payer,
        &w.issuer,
        &chain,
        0,
        &w.holder.key,
        &w.holder.wallet_token,
    );
    let output = chain_first_output(&chain).id;
    let envelope = reclaim_envelope(&buckspay::reclaim_domain(), &output, u32::MAX);
    let mut entries = chain.entries();
    let mut signatures: Vec<[u8; 64]> = chain.signed.iter().map(|s| s.signature).collect();
    entries.push((w.holder.key.sec1(), envelope));
    signatures.push(w.other.key.sign(&envelope));
    forged[0] = precompile_ix(&entries, &signatures);
    assert!(matches!(
        w.env.submit(&forged).unwrap_err(),
        TransactionError::InstructionError(0, _)
    ));
    assert_eq!(w.env.balance(&w.holder.wallet_token), 0);
    // A key with no registered device cannot reclaim at all (the output stays with the lock).
    let stranger = Key::new(9);
    let unregistered = Chain::issue(
        &w.issuer.key,
        &w.env.mint,
        0,
        0,
        AMOUNT,
        stranger.owner(),
        caveats(w.expiry, 4),
    );
    let ixs = reclaim_ixs(
        &w.env,
        &payer,
        &w.issuer,
        &unregistered,
        0,
        &stranger,
        &w.holder.wallet_token,
    );
    let err = w.env.submit(&ixs).unwrap_err();
    assert!(
        matches!(err, TransactionError::InstructionError(1, _)),
        "{err:?}"
    );
    assert_eq!(w.env.balance(&w.holder.wallet_token), 0);
}

#[test]
fn the_destination_must_belong_to_the_wallet_bound_to_the_owner_key() {
    let mut w = world();
    let chain = w.issue();
    w.after_settlement_window();
    let payer = w.env.payer.pubkey();
    let stranger = w.env.token_account_of(&Pubkey::new_unique(), 0);
    for destination in [stranger, w.other.wallet_token, w.issuer.wallet_token] {
        let ixs = reclaim_ixs(
            &w.env,
            &payer,
            &w.issuer,
            &chain,
            0,
            &w.holder.key,
            &destination,
        );
        let err = w.env.submit(&ixs).unwrap_err();
        assert!(anchor_constraint(&err, 1), "{err:?}");
        w.env.svm.expire_blockhash();
    }
    assert_eq!(
        w.env.balance(&stranger) + w.env.balance(&w.other.wallet_token),
        0
    );
    w.reclaim(&chain, 0, Who::Holder).unwrap();
    assert_eq!(w.env.balance(&w.holder.wallet_token), AMOUNT);
}

#[test]
fn a_reclaim_is_refused_at_the_end_of_the_lock_and_open_the_second_before() {
    // The output expires so late that the lock, not the retention, ends the window, whichever
    // windows the build has.
    let mut w = world();
    w.expiry = w.issuer.lock_until - GRACE - RECORD_TTL / 2;
    let (first, second) = (w.issue_n(0), w.issue_n(1));
    let lock_until = i64::from(w.issuer.lock_until);
    assert!(i64::from(w.expiry) + i64::from(GRACE) < lock_until);
    assert!(lock_until < window::closable_at(w.expiry, w.issuer.lock_until) as i64);
    w.at(lock_until);
    assert_eq!(
        w.reclaim(&second, 0, Who::Holder).unwrap_err(),
        code(1, E::LockEnded)
    );
    w.at(lock_until - 1);
    w.reclaim(&first, 0, Who::Holder).unwrap();
    assert_eq!(w.env.balance(&w.holder.wallet_token), AMOUNT);
}

#[test]
fn an_issue_beyond_what_the_lock_backs_cannot_be_reclaimed_or_settled_and_the_boundary_is_inclusive(
) {
    let mut w = world();
    let owner = w.holder.key.owner();
    let c = caveats(w.expiry, 4);
    let at =
        |start: u64, w: &W| Chain::issue(&w.issuer.key, &w.env.mint, 0, start, AMOUNT, owner, c);
    let over = at(BACKING - AMOUNT + 1, &w);
    let exact = at(BACKING - AMOUNT, &w);
    w.after_settlement_window();
    assert_eq!(
        w.reclaim(&over, 0, Who::Holder).unwrap_err(),
        code(1, E::WrongLock)
    );
    w.reclaim(&exact, 0, Who::Holder).unwrap();

    // The same boundary for a settlement.
    let mut w = world();
    let hop =
        |start: u64, w: &W| at(start, w).spend1_to_account(&w.holder.key, 0, &w.payee, NO_LOCK, 1);
    let over = hop(BACKING - AMOUNT + 1, &w);
    let exact = hop(BACKING - AMOUNT, &w);
    assert_eq!(w.settle(&over).unwrap_err(), code(1, E::WrongLock));
    w.settle(&exact).unwrap();
    assert_eq!(w.env.balance(&w.payee_token), AMOUNT);
}

#[test]
fn the_reclaim_window_follows_the_output_and_the_settlement_deadline_follows_the_last_consumed_output(
) {
    let mut w = world();
    let child_expiry = expiry_of(&w.env, 3);
    let to_other = |w: &W| {
        w.issue().spend(&w.holder.key, 0, |c| Spend {
            input: c.id,
            lock_seq: 0,
            salt: [9; 16],
            outputs: Outputs::One {
                owner: w.other.key.owner(),
                caveats: Caveats {
                    expiry: child_expiry,
                    hops_left: 3,
                    ..c.caveats
                },
            },
        })
    };
    let g = i64::from(GRACE);
    // Reclaim of the child output opens one second after the child's window, not the issue's.
    let handed = to_other(&w);
    w.at(i64::from(child_expiry) + g);
    assert_eq!(
        w.reclaim(&handed, 0, Who::Other).unwrap_err(),
        code(1, E::ReclaimTooEarly)
    );
    w.at(i64::from(child_expiry) + g + 1);
    w.reclaim(&handed, 0, Who::Other).unwrap();
    assert_eq!(w.env.balance(&w.other.wallet_token), AMOUNT);

    // Settlement of a chain through the child is closed when the child's window is, though the
    // first consumed output (the issue's) is still inside its own.
    let mut w = world();
    let settle = to_other(&w).spend1_to_account(&w.other.key, 0, &w.payee, NO_LOCK, 3);
    w.at(i64::from(child_expiry) + g + 1);
    assert_eq!(w.settle(&settle).unwrap_err(), code(1, E::SettlementClosed));
    w.at(i64::from(child_expiry) + g);
    w.settle(&settle).unwrap();
}

#[test]
fn the_window_ends_with_the_retention_to_the_second() {
    let mut w = world();
    let (a, b) = (w.issue_n(0), w.issue_n(1));
    let closable = window::closable_at(w.expiry, w.issuer.lock_until) as i64;
    assert_eq!(
        closable,
        i64::from(w.expiry) + i64::from(GRACE) + i64::from(RECORD_TTL)
    );
    w.at(closable);
    assert_eq!(
        w.reclaim(&b, 0, Who::Holder).unwrap_err(),
        code(1, E::ReclaimClosed)
    );
    w.at(closable - 1);
    w.reclaim(&a, 0, Who::Holder).unwrap();
}

#[test]
fn a_reclaim_is_refused_after_its_deadline_and_the_deadline_is_inclusive() {
    let mut w = world();
    let (a, b) = (w.issue_n(0), w.issue_n(1));
    let start = i64::from(w.expiry) + i64::from(GRACE) + 1;
    let deadline = start as u32 + 100;
    let send = |w: &mut W, chain: &Chain, deadline: u32| {
        let payer = w.env.payer.pubkey();
        let ixs = reclaim_ixs_with(
            &w.env,
            &payer,
            &w.issuer,
            chain,
            0,
            &w.holder.key,
            &w.holder.wallet_token,
            deadline,
        );
        w.env.submit(&ixs)
    };
    w.at(i64::from(deadline) + 1);
    assert_eq!(
        send(&mut w, &b, deadline).unwrap_err(),
        code(1, E::ReclaimExpired)
    );
    w.at(i64::from(deadline));
    send(&mut w, &a, deadline).unwrap();
    // Before the window opens the window's error wins over the deadline's.
    let mut w = world();
    let c = w.issue();
    w.at(i64::from(w.expiry) + i64::from(GRACE));
    assert_eq!(
        send(&mut w, &c, 1).unwrap_err(),
        code(1, E::ReclaimTooEarly)
    );
}

#[test]
fn a_second_reclaim_of_one_output_is_the_same_message_whatever_its_deadline() {
    let mut w = world();
    let chain = w.issue();
    w.after_settlement_window();
    let payer = w.env.payer.pubkey();
    let one = reclaim_ixs_with(
        &w.env,
        &payer,
        &w.issuer,
        &chain,
        0,
        &w.holder.key,
        &w.holder.wallet_token,
        u32::MAX,
    );
    w.env.submit(&one).unwrap();
    w.env.svm.expire_blockhash();
    let two = reclaim_ixs_with(
        &w.env,
        &payer,
        &w.issuer,
        &chain,
        0,
        &w.holder.key,
        &w.holder.wallet_token,
        u32::MAX - 1,
    );
    assert_eq!(w.env.submit(&two).unwrap_err(), code(1, E::AlreadySettled));
    assert_eq!(w.env.balance(&w.holder.wallet_token), AMOUNT);
}

#[test]
fn a_reclaim_after_a_settlement_is_a_conflict_and_the_payee_keeps_what_it_was_paid() {
    let mut w = world();
    let payer = w.env.payer.pubkey();
    let spent = w
        .issue()
        .spend1_to_account(&w.holder.key, 0, &w.payee, NO_LOCK, 1);
    w.settle(&spent).unwrap();
    let watched = [
        w.payee_token,
        escrow_address(&w.issuer.lock),
        ledger_address(&w.issuer.lock),
        w.holder.wallet_token,
    ];
    let before = w.env.digest(&watched);
    w.after_settlement_window();
    // The same output, reclaimed through a chain that does not contain the spend.
    let ixs = reclaim_ixs(
        &w.env,
        &payer,
        &w.issuer,
        &w.issue(),
        0,
        &w.holder.key,
        &w.holder.wallet_token,
    );
    assert_eq!(
        w.env.submit(&ixs).unwrap_err(),
        code(1, E::ConflictingSpend)
    );
    assert_eq!(w.env.digest(&watched), before);
    assert_eq!(w.env.balance(&w.payee_token), AMOUNT);
}

#[test]
fn a_settlement_after_a_reclaim_is_closed_and_a_clock_that_ran_back_changes_nothing() {
    let mut w = world();
    let chain = w.issue();
    let spent = chain
        .clone()
        .spend1_to_account(&w.holder.key, 0, &w.payee, NO_LOCK, 1);
    w.after_settlement_window();
    w.reclaim(&chain, 0, Who::Holder).unwrap();
    assert_eq!(w.env.balance(&w.holder.wallet_token), AMOUNT);
    // After the window: refused by the window.
    w.env.svm.expire_blockhash();
    assert_eq!(w.settle(&spent).unwrap_err(), code(1, E::SettlementClosed));
    // A clock that runs back into the settlement window: the record decides, nobody is paid twice.
    let watched = [
        w.payee_token,
        escrow_address(&w.issuer.lock),
        ledger_address(&w.issuer.lock),
        w.holder.wallet_token,
    ];
    let before = w.env.digest(&watched);
    w.at(i64::from(w.expiry) + i64::from(GRACE));
    assert_eq!(w.settle(&spent).unwrap_err(), code(1, E::ConflictingSpend));
    assert_eq!(w.env.digest(&watched), before);
    assert_eq!(w.env.balance(&w.payee_token), 0);
}

#[test]
fn the_clock_running_back_cannot_pay_a_settled_output_to_its_owner() {
    let mut w = world();
    let chain = w.issue();
    let spent = chain
        .clone()
        .spend1_to_account(&w.holder.key, 0, &w.payee, NO_LOCK, 1);
    w.settle(&spent).unwrap();
    // Forward past the window, then back into it: the reclaim and the settlement are both refused.
    w.after_settlement_window();
    assert_eq!(
        w.reclaim(&chain, 0, Who::Holder).unwrap_err(),
        code(1, E::ConflictingSpend)
    );
    w.at(i64::from(w.expiry) + i64::from(GRACE));
    assert_eq!(
        w.reclaim(&chain, 0, Who::Holder).unwrap_err(),
        code(1, E::ReclaimTooEarly)
    );
    assert_eq!(w.settle(&spent).unwrap_err(), code(1, E::AlreadySettled));
    assert_eq!(
        w.env.balance(&w.payee_token) + w.env.balance(&w.holder.wallet_token),
        AMOUNT
    );
}

fn long_chain(w: &W, spends: usize) -> Chain {
    let mut c = Chain::issue(
        &w.issuer.key,
        &w.env.mint,
        0,
        0,
        90_000_000,
        w.holder.key.owner(),
        caveats(w.expiry, 12),
    );
    for i in 0..spends {
        c = c.spend2(
            &w.holder.key,
            if i == 0 { 0 } else { 1 },
            Owner::Account(Pubkey::new_unique().to_bytes()),
            1_000_000,
            0,
            i as u8,
        );
    }
    c
}

#[test]
fn seven_spends_in_a_reclaim_are_refused_before_anything_else() {
    let mut w = world();
    let payer = w.env.payer.pubkey();
    // The precompile instruction is a valid one for the first eight messages: the refusal comes
    // before the program looks at it.
    let seven = long_chain(&w, 7);
    w.after_settlement_window();
    let (entries, signatures) = reclaim_entries(&seven, 1, &w.holder.key, u32::MAX);
    let ixs = vec![
        precompile_ix(&entries[..8], &signatures[..8]),
        reclaim_ix(
            &w.env,
            &payer,
            &w.issuer,
            &seven,
            1,
            &w.holder.key,
            &w.holder.wallet_token,
            u32::MAX,
        ),
    ];
    assert_eq!(w.env.send_v1(&ixs).unwrap_err(), code(1, E::TooManySpends));
}

#[test]
fn a_reclaim_of_six_spends_fits_eight_signatures_and_a_settlement_of_seven_does_too() {
    let mut w = world();
    let payer = w.env.payer.pubkey();
    let six = long_chain(&w, 6);
    w.after_settlement_window();
    let ixs = reclaim_ixs(
        &w.env,
        &payer,
        &w.issuer,
        &six,
        1,
        &w.holder.key,
        &w.holder.wallet_token,
    );
    let landed = w.env.send_v1(&ixs).unwrap();
    eprintln!(
        "reclaim of 6 spends: {} CU, {} B (v1)",
        landed.units, landed.size
    );
    assert!(landed.units <= 100_000 && landed.size <= 4_096);
    assert_eq!(
        w.env.balance(&w.holder.wallet_token),
        90_000_000 - 6_000_000
    );

    let mut w = world();
    let seven = long_chain(&w, 6).spend1_to_account(&w.holder.key, 1, &w.payee, NO_LOCK, 99);
    let payer = w.env.payer.pubkey();
    let ixs = settle_ixs(&w.env, &payer, &w.issuer, &seven, &w.payee_token);
    let landed = w.env.send_v1(&ixs).unwrap();
    eprintln!(
        "settlement of 7 spends: {} CU, {} B (v1)",
        landed.units, landed.size
    );
    assert!(landed.units <= 100_000 && landed.size <= 4_096);
}

#[test]
fn the_escrow_as_a_destination_is_refused_by_the_duplicate_account_check() {
    // `destination != escrow` in the context is documentation: Anchor refuses the same account
    // passed twice as mutable (error 2040) before any constraint runs, so this test, not the
    // constraint, is the defence.
    let mut w = world();
    let payer = w.env.payer.pubkey();
    let to_ledger = w
        .issue()
        .spend1_to_account(&w.holder.key, 0, &w.issuer.lock, NO_LOCK, 1);
    let escrow = escrow_address(&w.issuer.lock);
    let ixs = settle_ixs(&w.env, &payer, &w.issuer, &to_ledger, &escrow);
    assert_eq!(
        w.env.submit(&ixs).unwrap_err(),
        TransactionError::InstructionError(1, InstructionError::Custom(2040))
    );
    assert_eq!(w.env.ledger(&w.issuer.lock).backing_left, BACKING);
}
