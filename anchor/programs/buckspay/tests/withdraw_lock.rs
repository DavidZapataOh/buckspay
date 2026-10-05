mod common;
use anchor_lang::InstructionData;
use common::*;

const DAY: u32 = 24 * 60 * 60;

fn withdraw(
    env: &mut Env,
    user: &User,
    lock: &Lock,
    to: &Pubkey,
) -> Result<Landed, TransactionError> {
    let ix = withdraw_ix(env, user, lock, to);
    env.svm.expire_blockhash();
    env.send_signed(&user.wallet.pubkey(), &[ix], &[&user.wallet])
}

#[test]
fn withdrawal_opens_exactly_at_lock_until_plus_the_claim_window() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    let open = i64::from(lock.until) + i64::from(CLAIM_WINDOW);
    for t in [i64::from(lock.until) - 1, i64::from(lock.until), open - 1] {
        env.warp(t);
        let before = env.snapshot();
        let err = withdraw(&mut env, &user, &lock, &user.token).unwrap_err();
        assert_eq!(
            err,
            program_error(0, 6000 + BuckspayError::WithdrawTooEarly as u32),
            "t = {t}"
        );
        assert_eq!(env.snapshot(), before);
    }
    env.warp(open);
    withdraw(&mut env, &user, &lock, &user.token).unwrap();
    assert_eq!(env.balance(&user.token), 1_000);
    assert_eq!(env.lamports(&lock.escrow), 0, "the escrow is closed");
    let ledger = env.ledger(&lock.address);
    assert!(ledger.withdrawn);
    assert_eq!(
        (ledger.backing_left, ledger.bond_free, ledger.bond_slashed),
        (0, 0, 0)
    );
}

#[test]
fn only_the_current_wallet_withdraws_to_any_other_account_but_never_to_the_escrow() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let thief = env.user(0);
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    env.warp(i64::from(lock.until) + i64::from(CLAIM_WINDOW));

    let mut forged = withdraw_ix(&env, &user, &lock, &thief.token);
    forged.accounts[0].pubkey = thief.wallet.pubkey();
    let err = env
        .send_signed(&thief.wallet.pubkey(), &[forged], &[&thief.wallet])
        .unwrap_err();
    assert_eq!(
        err,
        TransactionError::InstructionError(0, InstructionError::Custom(2001))
    ); // ConstraintHasOne

    // A destination equal to the escrow is refused: a self-transfer would flag the lock withdrawn.
    let before = env.snapshot();
    let err = withdraw(&mut env, &user, &lock, &lock.escrow).unwrap_err();
    assert!(
        matches!(err, TransactionError::InstructionError(0, InstructionError::Custom(c)) if (2000..3000).contains(&c))
    );
    assert_eq!(env.snapshot(), before);

    let fresh = env.new_token_account(&Pubkey::new_unique());
    withdraw(&mut env, &user, &lock, &fresh).unwrap();
    assert_eq!(env.balance(&fresh), 500);
}

#[test]
fn rent_goes_back_to_whoever_paid_it_and_the_wallet_can_be_unfunded() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.unregistered_user(1_000);
    let s = env.sponsor.pubkey();
    let until = env.now() + MIN_LOCK + DAY;
    let ixs = onboard_ixs(&env, &user, &s, args_for(&user, 0, 100, 400, until), None);
    env.send_signed(&s, &ixs, &[&env.sponsor.insecure_clone(), &user.wallet])
        .unwrap();
    let lock = Lock::at(&user, 0, 100, 400, until);

    env.warp(i64::from(until) + i64::from(CLAIM_WINDOW));
    let before = env.lamports(&s);
    let ix = withdraw_ix(&env, &user, &lock, &user.token);
    env.send_signed(&s, &[ix], &[&env.sponsor.insecure_clone(), &user.wallet])
        .unwrap();
    assert_eq!(
        env.lamports(&s) + 2 * 5_000 - before,
        env.rent(165),
        "the escrow's rent is back at the payer, net of two fees"
    );
    assert_eq!(env.lamports(&user.wallet.pubkey()), 0);
}

#[test]
fn release_needs_no_signature_from_the_wallet_and_cannot_send_funds_anywhere_else() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.unregistered_user(1_000);
    let s = env.sponsor.pubkey();
    let until = env.now() + MIN_LOCK + DAY;
    let ixs = onboard_ixs(&env, &user, &s, args_for(&user, 0, 100, 400, until), None);
    env.send_signed(&s, &ixs, &[&env.sponsor.insecure_clone(), &user.wallet])
        .unwrap();
    let lock = Lock::at(&user, 0, 100, 400, until);
    let open = i64::from(until) + i64::from(CLAIM_WINDOW) + i64::from(RELEASE_DELAY);

    for t in [i64::from(until) + i64::from(CLAIM_WINDOW), open - 1] {
        // withdrawal is open, release is not
        env.warp(t);
        let before = env.snapshot();
        let ix = release_ix(&env, &user, &lock, &user.token, &s);
        let err = env
            .send_signed(&s, &[ix], &[&env.sponsor.insecure_clone()])
            .unwrap_err();
        assert_eq!(
            err,
            program_error(0, 6000 + BuckspayError::ReleaseTooEarly as u32),
            "t = {t}"
        );
        assert_eq!(env.snapshot(), before);
    }
    env.warp(open);
    // A destination the wallet does not own is refused.
    let stranger = env.new_token_account(&Pubkey::new_unique());
    let ix = release_ix(&env, &user, &lock, &stranger, &s);
    let err = env
        .send_signed(&s, &[ix], &[&env.sponsor.insecure_clone()])
        .unwrap_err();
    assert_eq!(
        err,
        TransactionError::InstructionError(0, InstructionError::Custom(2015))
    ); // ConstraintTokenOwner
       // The sponsor releases alone: funds reach the wallet's own account, the escrow rent returns to the sponsor.
    let before = env.lamports(&s);
    let ix = release_ix(&env, &user, &lock, &user.token, &s);
    env.send_signed(&s, &[ix], &[&env.sponsor.insecure_clone()])
        .unwrap();
    assert_eq!(env.balance(&user.token), 1_000);
    assert_eq!(env.lamports(&s) + 5_000 - before, env.rent(165));
    assert!(env.ledger(&lock.address).withdrawn);
}

#[test]
fn a_slashed_pool_stays_and_the_escrow_stays_open_until_it_is_paid() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    // What 02-03 will do, applied directly: 30 of the bond committed, 10 of the backing paid.
    env.edit_ledger(&lock.address, |l| l.commit_slash(30).unwrap());
    env.pay(&lock, |l| l.pay_backing(10));
    env.warp(i64::from(lock.until) + i64::from(CLAIM_WINDOW));

    withdraw(&mut env, &user, &lock, &user.token).unwrap();
    assert_eq!(
        env.balance(&user.token),
        960,
        "500 stayed in the wallet; backing_left 390 + bond_free 70 came back"
    );
    assert_eq!(env.balance(&lock.escrow), 30);
    assert!(env.lamports(&lock.escrow) > 0);
    assert_eq!(env.ledger(&lock.address).bond_slashed, 30);

    env.warp(i64::from(lock.until) + i64::from(RECORD_TTL));
    let w = user.wallet.pubkey();
    let err = env
        .send_signed(&w, &[close_ix(&lock, user.key.sec1(), &w)], &[&user.wallet])
        .unwrap_err();
    assert_eq!(
        err,
        program_error(0, 6000 + BuckspayError::SlashPending as u32)
    );
}

#[test]
fn a_donation_or_a_released_residue_after_the_withdrawal_is_swept_by_a_second_withdrawal() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    env.edit_ledger(&lock.address, |l| {
        l.commit_slash(30).unwrap();
    });
    env.warp(i64::from(lock.until) + i64::from(CLAIM_WINDOW));
    withdraw(&mut env, &user, &lock, &user.token).unwrap(); // pool of 30 keeps the escrow open
    env.donate(&lock, 7);
    env.pay(&lock, |l| l.pay_slashed(20));
    env.edit_ledger(&lock.address, |l| l.release_slashed(10).unwrap());
    withdraw(&mut env, &user, &lock, &user.token).unwrap(); // sweeps the 7 and the released 10, closes the escrow
    assert_eq!(env.lamports(&lock.escrow), 0);
    assert_eq!(env.balance(&user.token), 500 + 470 + 17);
}

/// A griefer sends the rent minimum to the escrow's dead address after it was closed; close_lock
/// must still finish and hand the gift to the payer.
#[test]
fn a_griefed_dead_escrow_address_does_not_block_closing() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.unregistered_user(1_000);
    let s = env.sponsor.pubkey();
    let until = env.now() + MIN_LOCK + DAY;
    let ixs = onboard_ixs(&env, &user, &s, args_for(&user, 0, 100, 400, until), None);
    env.send_signed(&s, &ixs, &[&env.sponsor.insecure_clone(), &user.wallet])
        .unwrap();
    let lock = Lock::at(&user, 0, 100, 400, until);
    env.warp(i64::from(until) + i64::from(CLAIM_WINDOW));
    let ix = withdraw_ix(&env, &user, &lock, &user.token);
    env.send_signed(&s, &[ix], &[&env.sponsor.insecure_clone(), &user.wallet])
        .unwrap();
    assert_eq!(env.lamports(&lock.escrow), 0);

    let gift = env.rent(0).max(890_880);
    env.set_account(
        lock.escrow,
        Account {
            lamports: gift,
            data: vec![],
            owner: system_program::ID,
            executable: false,
            rent_epoch: 0,
        },
    );

    let stranger = env.funded_keypair();
    let close = close_ix(&lock, user.key.sec1(), &s);
    env.warp(i64::from(until) + i64::from(RECORD_TTL) - 1);
    let err = env
        .send_signed(
            &stranger.pubkey(),
            std::slice::from_ref(&close),
            &[&stranger],
        )
        .unwrap_err();
    assert_eq!(
        err,
        program_error(0, 6000 + BuckspayError::CloseTooEarly as u32)
    );
    env.warp(i64::from(until) + i64::from(RECORD_TTL));
    let before = env.lamports(&s);
    env.send_signed(&stranger.pubkey(), &[close], &[&stranger])
        .unwrap();
    assert_eq!(
        env.lamports(&s) - before,
        env.rent(62) + env.rent(103) + gift,
        "Lock, Ledger and the gift go to the payer"
    );
    assert!(
        env.svm.get_account(&lock.address).is_none() && env.svm.get_account(&lock.ledger).is_none()
    );
    assert_eq!(env.lamports(&lock.escrow), 0);

    // The number is spent for good.
    let reuse = create_lock_ix(
        &env,
        &user,
        &s,
        args_for(&user, 0, 1, 1, env.now() + MIN_LOCK + DAY),
        None,
    );
    let err = env
        .send_signed(&s, &[reuse], &[&env.sponsor.insecure_clone(), &user.wallet])
        .unwrap_err();
    assert_eq!(
        err,
        program_error(0, 6000 + BuckspayError::LockSeqMismatch as u32)
    );
    assert_eq!(env.device(&user.key.sec1()).next_lock_seq, 1);
}

#[test]
fn close_lock_checks_its_conditions_in_order_and_a_fake_escrow_address_is_refused() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    let w = user.wallet.pubkey();
    env.warp(i64::from(lock.until) + i64::from(RECORD_TTL));
    let attempt =
        |env: &mut Env, ix: Instruction| env.send_signed(&w, &[ix], &[&user.wallet]).unwrap_err();
    assert_eq!(
        attempt(&mut env, close_ix(&lock, user.key.sec1(), &w)),
        program_error(0, 6000 + BuckspayError::NotWithdrawn as u32)
    );
    env.edit_ledger(&lock.address, |l| {
        l.withdrawn = true;
        l.commit_slash(5).unwrap();
    });
    assert_eq!(
        attempt(&mut env, close_ix(&lock, user.key.sec1(), &w)),
        program_error(0, 6000 + BuckspayError::SlashPending as u32)
    );
    env.pay(&lock, |l| l.pay_slashed(5));
    assert_eq!(
        attempt(&mut env, close_ix(&lock, user.key.sec1(), &w)),
        program_error(0, 6000 + BuckspayError::EscrowOpen as u32),
        "the escrow is still a token account"
    );
    let mut fake = close_ix(&lock, user.key.sec1(), &w);
    fake.accounts[2].pubkey = Pubkey::new_unique();
    assert!(
        matches!(attempt(&mut env, fake), TransactionError::InstructionError(0, InstructionError::Custom(c)) if (2000..4000).contains(&c))
    );
    let mut wrong_receiver = close_ix(&lock, user.key.sec1(), &w);
    wrong_receiver.accounts[3].pubkey = Pubkey::new_unique();
    assert_eq!(
        attempt(&mut env, wrong_receiver),
        TransactionError::InstructionError(0, InstructionError::Custom(2012))
    ); // ConstraintAddress
}

#[test]
fn withdraw_twice_in_a_row_changes_nothing_after_the_escrow_is_closed() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    env.warp(i64::from(lock.until) + i64::from(CLAIM_WINDOW));
    withdraw(&mut env, &user, &lock, &user.token).unwrap();
    let before = env.snapshot();
    assert!(withdraw(&mut env, &user, &lock, &user.token).is_err());
    assert_eq!(env.snapshot(), before);
}

#[test]
fn withdraw_checks_the_pdas_of_its_arguments() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(2_000);
    let a = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    let b = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    env.warp(i64::from(a.until.max(b.until)) + i64::from(CLAIM_WINDOW));
    let w = user.wallet.pubkey();
    // Positions in the account list: lock 2, ledger 3, escrow 4.
    for slot in [2, 3, 4] {
        let mut ix = withdraw_ix(&env, &user, &a, &user.token);
        ix.accounts[slot].pubkey = [b.address, b.ledger, b.escrow][slot - 2];
        let before = env.snapshot();
        assert_eq!(
            env.send_signed(&w, &[ix], &[&user.wallet]).unwrap_err(),
            program_error(0, 2006),
            "slot {slot}"
        );
        assert_eq!(env.snapshot(), before);
    }
    // The accounts of lock a with the sequence number of lock b.
    let mut ix = withdraw_ix(&env, &user, &a, &user.token);
    ix.data = buckspay::instruction::WithdrawLock {
        key: user.key.sec1(),
        lock_seq: b.seq,
    }
    .data();
    assert_eq!(
        env.send_signed(&w, &[ix], &[&user.wallet]).unwrap_err(),
        program_error(0, 2006)
    );
}

#[test]
fn withdraw_rejects_a_destination_of_another_mint_and_a_wrong_rent_receiver() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    env.warp(i64::from(lock.until) + i64::from(CLAIM_WINDOW));
    let w = user.wallet.pubkey();
    let foreign = env.foreign_token_account(&Pubkey::new_unique(), &w, 0);
    let ix = withdraw_ix(&env, &user, &lock, &foreign);
    assert_eq!(
        env.send_signed(&w, &[ix], &[&user.wallet]).unwrap_err(),
        program_error(0, 2014)
    ); // ConstraintTokenMint
    let mut ix = withdraw_ix(&env, &user, &lock, &user.token);
    ix.accounts[7].pubkey = Pubkey::new_unique();
    assert_eq!(
        env.send_signed(&w, &[ix], &[&user.wallet]).unwrap_err(),
        program_error(0, 2012)
    ); // ConstraintAddress
}

#[test]
fn withdraw_and_release_work_for_token2022_locks() {
    let mut env = Env::new(TokenKind::Token2022);
    let user = env.user(1_000);
    let a = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    let b = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    env.warp(i64::from(a.until.max(b.until)) + i64::from(CLAIM_WINDOW));
    withdraw(&mut env, &user, &a, &user.token).unwrap();
    assert_eq!(env.balance(&user.token), 500);
    env.warp(i64::from(b.until) + i64::from(CLAIM_WINDOW) + i64::from(RELEASE_DELAY));
    env.try_release(&user, &b).unwrap();
    assert_eq!(env.balance(&user.token), 1_000);
    assert_eq!(env.lamports(&b.escrow), 0);
}

/// A wallet with no token account of the mint cannot be released to: the call fails and nothing
/// changes. Nothing in the program can force a wallet to hold a token account.
#[test]
fn release_refuses_a_wallet_without_a_token_account() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    env.warp(i64::from(lock.until) + i64::from(CLAIM_WINDOW) + i64::from(RELEASE_DELAY));
    let s = env.sponsor.pubkey();
    let missing = Pubkey::new_unique();
    let ix = release_ix(&env, &user, &lock, &missing, &s);
    let before = env.snapshot();
    let err = env
        .send_signed(&s, &[ix], &[&env.sponsor.insecure_clone()])
        .unwrap_err();
    assert!(
        matches!(err, TransactionError::InstructionError(0, InstructionError::Custom(c)) if (3000..4000).contains(&c)),
        "{err:?}"
    );
    assert_eq!(env.snapshot(), before);
}

#[test]
fn withdraw_after_the_wallet_rotated_goes_to_the_new_wallet_only() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    let new = env.funded_keypair();
    let w = user.wallet.pubkey();
    let ixs = request_ix(&env, &user, &new.pubkey(), &w, 0);
    env.send_signed(&w, &ixs, &[&user.wallet, &new]).unwrap();
    env.warp(i64::from(env.now()) + i64::from(ROTATION_DELAY));
    env.send_signed(&new.pubkey(), &[apply_ix(&user.key.sec1(), &w)], &[&new])
        .unwrap();
    env.warp(i64::from(lock.until) + i64::from(CLAIM_WINDOW));

    let err = withdraw(&mut env, &user, &lock, &user.token).unwrap_err();
    assert_eq!(err, program_error(0, 2001)); // ConstraintHasOne
    let dest = env.new_token_account(&new.pubkey());
    let as_new = User {
        wallet: new.insecure_clone(),
        key: user.key.clone(),
        token: dest,
    };
    withdraw(&mut env, &as_new, &lock, &dest).unwrap();
    assert_eq!(env.balance(&dest), 500);
}

#[test]
fn stored_bumps_are_canonical() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    let key = user.key.sec1();
    let bump = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &buckspay::ID).1;

    assert_eq!(
        env.device(&key).bump,
        bump(&[buckspay::DEVICE_SEED, &key[..1], &key[1..]])
    );
    let record: buckspay::state::Lock = env.account(&lock.address);
    assert_eq!(
        record.bump,
        bump(&[
            buckspay::LOCK_SEED,
            &key[..1],
            &key[1..],
            &lock.seq.to_le_bytes()
        ])
    );
    assert_eq!(
        env.ledger(&lock.address).bump,
        bump(&[buckspay::LEDGER_SEED, lock.address.as_ref()])
    );

    let new = env.funded_keypair();
    let w = user.wallet.pubkey();
    let ixs = request_ix(&env, &user, &new.pubkey(), &w, 0);
    env.send_signed(&w, &ixs, &[&user.wallet, &new]).unwrap();
    assert_eq!(
        env.rotation(&key).bump,
        bump(&[buckspay::ROTATION_SEED, &key[..1], &key[1..]])
    );
}

/// A closed lock leaves no `Lock` account, its number stays below the device's counter and is
/// never reusable, and the clock at the close proves its `lock_until` is past; the number at the
/// counter has no account because it was never created.
#[test]
fn a_closed_lock_is_told_apart_from_a_never_created_one_and_proves_its_lock_until_is_past() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let key = user.key.sec1();
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    env.warp(i64::from(lock.until) + i64::from(CLAIM_WINDOW));
    withdraw(&mut env, &user, &lock, &user.token).unwrap();
    let closes_at = i64::from(lock.until) + i64::from(RECORD_TTL);
    env.warp(closes_at);
    env.try_close(&user, &lock).unwrap();

    assert!(
        env.svm.get_account(&lock.address).is_none(),
        "the record is gone"
    );
    let counter = env.device(&key).next_lock_seq;
    assert!(
        lock.seq < counter,
        "the number is below the counter: it was created"
    );
    assert!(
        env.svm.get_account(&lock_address(&key, counter)).is_none(),
        "the counter's own number was never created"
    );
    let w = user.wallet.pubkey();
    let reuse = create_lock_ix(
        &env,
        &user,
        &w,
        args_for(&user, lock.seq, 1, 1, env.now() + MIN_LOCK + DAY),
        None,
    );
    assert_eq!(
        env.send_signed(&w, &[reuse], &[&user.wallet]).unwrap_err(),
        program_error(0, 6000 + BuckspayError::LockSeqMismatch as u32)
    );
    assert_eq!(
        env.device(&key).next_lock_seq,
        counter,
        "the counter never decreases"
    );

    // The clock at the close is at least lock_until + RECORD_TTL, so a ticket claiming a later
    // lock_until over this number is provably false, and the genuine one is not.
    let now = u64::from(env.now());
    assert!(now >= u64::from(lock.until) + u64::from(RECORD_TTL));
    let ttl = u64::from(RECORD_TTL);
    assert!(!buckspay::rules::closed_lock_ticket_is_false(
        lock.until, now, ttl
    ));
    assert!(buckspay::rules::closed_lock_ticket_is_false(
        u32::try_from(now - ttl + 1).unwrap(),
        now,
        ttl
    ));
    assert!(!buckspay::rules::closed_lock_ticket_is_false(
        u32::try_from(now - ttl).unwrap(),
        now,
        ttl
    ));
}

/// Once the pool is paid out the escrow can be empty yet open, and so can an escrow whose backing
/// was all spent: a withdrawal or a release has nothing to transfer then, and must still close the
/// escrow, or the rent of the lock's three accounts would be stuck for good.
#[test]
fn an_empty_escrow_is_closed_by_a_release_and_the_lock_can_then_close() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    env.edit_ledger(&lock.address, |l| l.commit_slash(30).unwrap());
    env.warp(i64::from(lock.until) + i64::from(CLAIM_WINDOW));
    withdraw(&mut env, &user, &lock, &user.token).unwrap();
    env.pay(&lock, |l| l.pay_slashed(30));
    assert_eq!(env.balance(&lock.escrow), 0);
    assert!(env.lamports(&lock.escrow) > 0, "empty, but still open");

    env.warp(i64::from(lock.until) + i64::from(CLAIM_WINDOW) + i64::from(RELEASE_DELAY));
    env.try_release(&user, &lock).unwrap();
    assert_eq!(env.lamports(&lock.escrow), 0, "the release closed it");
    env.warp(i64::from(lock.until) + i64::from(RECORD_TTL));
    env.try_close(&user, &lock).unwrap();
    assert!(env.svm.get_account(&lock.address).is_none());
}

/// The same for a lock whose backing was all spent and whose bond is zero.
#[test]
fn a_lock_whose_funds_were_all_paid_out_can_still_be_withdrawn_and_closed() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let lock = lock_for(&mut env, &user, 0, 400, MIN_LOCK + DAY);
    env.pay(&lock, |l| l.pay_backing(400));
    env.warp(i64::from(lock.until) + i64::from(CLAIM_WINDOW));
    withdraw(&mut env, &user, &lock, &user.token).unwrap();
    assert_eq!(env.lamports(&lock.escrow), 0);
    assert!(env.ledger(&lock.address).withdrawn);
}
