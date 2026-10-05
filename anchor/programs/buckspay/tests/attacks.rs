mod common;
use common::*;

const DAY: u32 = 24 * 60 * 60;

#[test]
fn a_foreign_program_is_not_a_token_program() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let w = user.wallet.pubkey();
    let until = env.now() + MIN_LOCK + DAY;
    // A deployed program that is not a token program; any invocation of it would show in the logs.
    let evil = env.foreign_program();
    let mut ix = create_lock_ix(&env, &user, &w, args_for(&user, 0, 100, 100, until), None);
    let i = ix
        .accounts
        .iter()
        .position(|a| a.pubkey == env.token_program)
        .unwrap();
    ix.accounts[i].pubkey = evil;
    let before = env.snapshot();
    let err = env.send_signed(&w, &[ix], &[&user.wallet]).unwrap_err();
    assert_eq!(
        err,
        TransactionError::InstructionError(0, InstructionError::Custom(3008))
    ); // InvalidProgramId
    assert_eq!(env.snapshot(), before);
    assert_eq!(
        env.invocations_of(&evil),
        0,
        "the foreign program was never called"
    );
}

#[test]
fn frozen_accounts_fail_cleanly_and_recover() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(2_000);
    let a = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    let b = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    env.warp(i64::from(a.until.max(b.until)) + i64::from(CLAIM_WINDOW));
    let w = user.wallet.pubkey();
    let frozen = TransactionError::InstructionError(0, InstructionError::Custom(17)); // TokenError::AccountFrozen

    // 1. The issuer freezes lock A's escrow: withdrawal fails and no bucket moves.
    env.freeze(&a.escrow);
    let before = env.snapshot();
    let err = env
        .send_signed(
            &w,
            &[withdraw_ix(&env, &user, &a, &user.token)],
            &[&user.wallet],
        )
        .unwrap_err();
    assert_eq!(err, frozen);
    assert_eq!(
        env.snapshot(),
        before,
        "drain and the transfer are one atomic transaction"
    );
    env.thaw(&a.escrow);
    env.send_signed(
        &w,
        &[withdraw_ix(&env, &user, &a, &user.token)],
        &[&user.wallet],
    )
    .unwrap();
    assert_eq!(env.balance(&user.token), 1_000 + 500);

    // 2. The wallet's own account is frozen: it names another destination for lock B.
    env.freeze(&user.token);
    let err = env
        .send_signed(
            &w,
            &[withdraw_ix(&env, &user, &b, &user.token)],
            &[&user.wallet],
        )
        .unwrap_err();
    assert_eq!(err, frozen);
    let fresh = env.new_token_account(&Pubkey::new_unique());
    env.send_signed(&w, &[withdraw_ix(&env, &user, &b, &fresh)], &[&user.wallet])
        .unwrap();
    assert_eq!(env.balance(&fresh), 500);

    // 3. A frozen funding account refuses a new lock and leaves no trace.
    let before = env.snapshot();
    let seq = env.device(&user.key.sec1()).next_lock_seq;
    let ix = create_lock_ix(
        &env,
        &user,
        &w,
        args_for(&user, seq, 10, 10, env.now() + MIN_LOCK + DAY),
        None,
    );
    assert_eq!(
        env.send_signed(&w, &[ix], &[&user.wallet]).unwrap_err(),
        frozen
    );
    assert_eq!(env.snapshot(), before);
}

#[test]
fn clock_extremes_are_refused_without_panicking() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let w = user.wallet.pubkey();
    for (clock, until, expected) in [
        (-1, 1_900_000_000, BuckspayError::ClockOutOfRange),
        (
            i64::from(u32::MAX) + 1,
            u32::MAX,
            BuckspayError::ClockOutOfRange,
        ),
        (
            i64::from(u32::MAX) - 10,
            u32::MAX,
            BuckspayError::LockTooShort,
        ),
        (0, u32::MAX, BuckspayError::LockTooLong),
    ] {
        env.warp(clock);
        let ix = create_lock_ix(&env, &user, &w, args_for(&user, 0, 1, 1, until), None);
        let err = env.send_signed(&w, &[ix], &[&user.wallet]).unwrap_err();
        assert_eq!(
            err,
            program_error(0, 6000 + expected as u32),
            "clock {clock}, until {until}"
        );
    }
}

#[test]
fn substituted_accounts_are_refused() {
    let mut env = Env::new(TokenKind::Classic);
    let a = env.user(1_000);
    let b = env.user(1_000);
    let la = lock_for(&mut env, &a, 100, 400, MIN_LOCK + DAY);
    let lb = lock_for(&mut env, &b, 100, 400, MIN_LOCK + DAY);
    env.warp(i64::from(la.until.max(lb.until)) + i64::from(CLAIM_WINDOW));
    let wa = a.wallet.pubkey();
    // Positions in the withdraw_lock account list (index section 5).
    const LOCK: usize = 2;
    const LEDGER: usize = 3;
    const ESCROW: usize = 4;
    for (slot, replacement, label) in [
        (ESCROW, lb.escrow, "escrow of another lock"),
        (LEDGER, lb.ledger, "ledger of another lock"),
        (LOCK, lb.address, "lock of another key"),
        (ESCROW, a.token, "the wallet's own token account as escrow"),
        (LEDGER, la.address, "the lock as its own ledger"),
    ] {
        let mut ix = withdraw_ix(&env, &a, &la, &a.token);
        ix.accounts[slot].pubkey = replacement;
        let before = env.snapshot();
        let err = env.send_signed(&wa, &[ix], &[&a.wallet]).unwrap_err();
        assert!(
            matches!(err, TransactionError::InstructionError(0, InstructionError::Custom(c)) if (2000..4000).contains(&c)),
            "{label}: {err:?}"
        );
        assert_eq!(env.snapshot(), before, "{label}");
    }
}

#[test]
fn the_janitor_cannot_be_turned_into_a_payout_to_someone_else() {
    let mut env = Env::new(TokenKind::Classic);
    let victim = env.user(1_000);
    let attacker = env.user(0);
    let lock = lock_for(&mut env, &victim, 100, 400, MIN_LOCK + DAY);
    env.warp(i64::from(lock.until) + i64::from(CLAIM_WINDOW) + i64::from(RELEASE_DELAY));
    let s = env.sponsor.pubkey();
    let ix = release_ix(&env, &victim, &lock, &attacker.token, &s); // destination owned by the attacker
    let before = env.snapshot();
    let err = env
        .send_signed(&s, &[ix], &[&env.sponsor.insecure_clone()])
        .unwrap_err();
    assert_eq!(
        err,
        TransactionError::InstructionError(0, InstructionError::Custom(2015))
    ); // ConstraintTokenOwner
    assert_eq!(env.snapshot(), before);
}

#[test]
fn no_instruction_reduces_a_locks_lamports_except_close() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    let held = |env: &Env| (env.lamports(&lock.address), env.lamports(&lock.ledger));
    let created = held(&env);
    assert_eq!(created, (env.rent(61), env.rent(103)));

    env.donate(&lock, 5);
    env.edit_ledger(&lock.address, |l| l.commit_slash(30).map(drop).unwrap());
    assert_eq!(held(&env), created);
    env.warp(i64::from(lock.until) + i64::from(CLAIM_WINDOW));
    let w = user.wallet.pubkey();
    env.send(
        &user.wallet,
        &[withdraw_ix(&env, &user, &lock, &user.token)],
    )
    .unwrap();
    assert_eq!(
        held(&env),
        created,
        "withdrawing moves tokens and the escrow's rent, never the record's"
    );
    env.pay(&lock, |l| l.pay_slashed(30));
    env.warp(i64::from(lock.until) + i64::from(RELEASE_DELAY) + i64::from(CLAIM_WINDOW));
    env.try_release(&user, &lock).unwrap();
    assert_eq!(held(&env), created);
    env.send(&user.wallet, &[close_ix(&lock, user.key.sec1(), &w)])
        .unwrap();
    assert_eq!(held(&env), (0, 0), "only close_lock lowers them");
}

#[test]
fn the_fee_recipient_must_be_the_payers_token_account() {
    let mut env = Env::new(TokenKind::Classic);
    let s = env.sponsor.pubkey();
    let user = env.unregistered_user(1_000);
    let third_party = env.new_token_account(&Keypair::new().pubkey());
    let until = env.now() + MIN_LOCK + DAY;
    for fee in [0, 1] {
        let mut a = args_for(&user, 0, 100, 100, until);
        a.sponsor_fee = fee;
        let ixs = onboard_ixs(&env, &user, &s, a, Some(third_party));
        let before = env.snapshot();
        let err = env
            .send_signed(&s, &ixs, &[&env.sponsor.insecure_clone(), &user.wallet])
            .unwrap_err();
        assert_eq!(err, program_error(2, 2015), "fee {fee}"); // ConstraintTokenOwner
        assert_eq!(env.snapshot(), before);
    }
}

#[test]
fn fee_and_funds_move_in_one_transaction() {
    let mut env = Env::new(TokenKind::Classic);
    let s = env.sponsor.pubkey();
    let user = env.unregistered_user(200); // exactly the funds, nothing for the fee
    let until = env.now() + MIN_LOCK + DAY;
    let mut a = args_for(&user, 0, 100, 100, until);
    a.sponsor_fee = 1;
    let ixs = onboard_ixs(&env, &user, &s, a, Some(env.sponsor_token));
    let before = env.snapshot();
    let err = env
        .send_signed(&s, &ixs, &[&env.sponsor.insecure_clone(), &user.wallet])
        .unwrap_err();
    assert_eq!(
        err,
        program_error(2, 1),
        "the token program refuses the fee: insufficient funds"
    );
    assert_eq!(
        env.snapshot(),
        before,
        "neither the funds nor the registration landed"
    );
}

#[test]
fn rotation_does_not_change_a_ticket_relevant_field() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    let record = |env: &Env| env.svm.get_account(&lock.address).unwrap().data;
    let before = record(&env);
    let new = env.funded_keypair();
    let w = user.wallet.pubkey();
    let key = user.key.sec1();
    let ixs = request_ix(&env, &user, &new.pubkey(), &w, 0);
    env.send_signed(&w, &ixs, &[&user.wallet, &new]).unwrap();
    assert_eq!(record(&env), before, "a pending rotation");
    env.send(&user.wallet, &[cancel_ix(&key, &w, &w)]).unwrap();
    assert_eq!(record(&env), before, "a cancelled rotation");
    let ixs = request_ix(&env, &user, &new.pubkey(), &w, 1);
    env.send_signed(&w, &ixs, &[&user.wallet, &new]).unwrap();
    env.warp(i64::from(env.now()) + i64::from(ROTATION_DELAY));
    env.send_signed(&new.pubkey(), &[apply_ix(&key, &w)], &[&new])
        .unwrap();
    assert_eq!(record(&env), before, "an applied rotation");
}

#[test]
fn a_lock_over_a_foreign_mint_is_isolated() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let honest = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    let honest_state = (env.balance(&honest.escrow), env.ledger(&honest.address));

    let w = user.wallet.pubkey();
    let foreign_mint = env.add_mint(0);
    let funder = env.foreign_token_account(&foreign_mint, &w, 77);
    let until = env.now() + MIN_LOCK + DAY;
    let mut ix = create_lock_ix(&env, &user, &w, args_for(&user, 1, 7, 70, until), None);
    ix.accounts[6].pubkey = foreign_mint;
    ix.accounts[7].pubkey = funder;
    env.send(&user.wallet, &[ix]).unwrap();

    let foreign = Lock::at(&user, 1, 7, 70, until);
    assert_eq!(env.token_account(&foreign.escrow).mint, foreign_mint);
    assert_eq!(env.balance(&foreign.escrow), 77);
    assert_eq!(
        env.balance(&user.token),
        500,
        "the user's USDC is untouched"
    );
    assert_eq!(
        (env.balance(&honest.escrow), env.ledger(&honest.address)),
        honest_state
    );
    let record: buckspay::state::Lock = env.account(&foreign.address);
    assert_eq!(record.mint, foreign_mint);
}

#[test]
fn withdraw_lock_cannot_be_called_after_the_escrow_closed() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    env.warp(i64::from(lock.until) + i64::from(CLAIM_WINDOW));
    env.send(
        &user.wallet,
        &[withdraw_ix(&env, &user, &lock, &user.token)],
    )
    .unwrap();
    let before = env.snapshot();
    let err = env
        .send(
            &user.wallet,
            &[withdraw_ix(&env, &user, &lock, &user.token)],
        )
        .unwrap_err();
    assert!(
        matches!(err, TransactionError::InstructionError(0, InstructionError::Custom(c)) if (3000..4000).contains(&c)),
        "{err:?}"
    );
    assert_eq!(env.snapshot(), before);
}
