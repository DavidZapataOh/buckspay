mod common;
use common::*;

/// Runs register, create, rotation request/cancel/request/apply, withdraw, release, close and (devnet) migrate on the
/// real SBF binary. A stack or heap fault in any account context surfaces as ProgramFailedToComplete.
#[test]
fn every_instruction_runs_on_the_built_binary() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(10_000); // register_device
    let a = lock_for(&mut env, &user, 100, 400, MIN_LOCK + 86_400); // create_lock
    let b = lock_for(&mut env, &user, 50, 0, MIN_LOCK + 86_400);

    let t0 = i64::from(env.now());
    let new = env.funded_keypair();
    let w = user.wallet.pubkey();
    env.send_signed(
        &w,
        &request_ix(&env, &user, &new.pubkey(), &w, 0),
        &[&user.wallet, &new],
    )
    .unwrap(); // request
    env.send_signed(&w, &[cancel_ix(&user.key.sec1(), &w, &w)], &[&user.wallet])
        .unwrap(); // cancel
    env.send_signed(
        &w,
        &request_ix(&env, &user, &new.pubkey(), &w, 1),
        &[&user.wallet, &new],
    )
    .unwrap();
    env.warp(t0 + i64::from(ROTATION_DELAY));
    env.send_signed(&new.pubkey(), &[apply_ix(&user.key.sec1(), &w)], &[&new])
        .unwrap(); // apply
    assert_eq!(env.device(&user.key.sec1()).wallet, new.pubkey());

    // The new wallet withdraws lock a; anyone releases lock b once its window is open; both are closed.
    env.warp(i64::from(a.until.max(b.until)) + i64::from(CLAIM_WINDOW));
    let dest = env.new_token_account(&new.pubkey());
    let as_new = User {
        wallet: new.insecure_clone(),
        key: user.key.clone(),
        token: dest,
    };
    env.send_signed(
        &new.pubkey(),
        &[withdraw_ix(&env, &as_new, &a, &dest)],
        &[&new],
    )
    .unwrap(); // withdraw
    env.warp(i64::from(b.until) + i64::from(CLAIM_WINDOW) + i64::from(RELEASE_DELAY));
    let stranger = env.funded_keypair();
    env.send_signed(
        &stranger.pubkey(),
        &[release_ix(&env, &user, &b, &dest, &w)],
        &[&stranger],
    )
    .unwrap(); // release
               // Release opens after CLAIM_WINDOW + RELEASE_DELAY, which is not before RECORD_TTL, so close is open too.
    for lock in [&a, &b] {
        env.send_signed(
            &stranger.pubkey(),
            &[close_ix(lock, user.key.sec1(), &w)],
            &[&stranger],
        )
        .unwrap(); // close
    }
    assert_eq!(env.balance(&dest), 500 + 50);

    #[cfg(feature = "devnet")]
    {
        let legacy = env.user(0);
        env.shrink_device_to_legacy(&legacy.key.sec1());
        env.send(&user.wallet, &[migrate_ix(&w, legacy.key.sec1())])
            .unwrap(); // migrate_device
        assert_eq!(env.device(&legacy.key.sec1()).next_lock_seq, 0);
    }
}

/// Runs `settle_note`, `record_prefix`, `reclaim_output` and `close_spent` on the real SBF binary.
#[test]
fn every_settlement_instruction_runs_on_the_built_binary() {
    use buckspay_protocol::{GRACE, NO_LOCK};

    let mut env = Env::new(TokenKind::Classic);
    let issuer = env.issuer(1, 100_000_000, 1_000_000_000, 60);
    let holder = env.issuer(2, 1_000_000, 10_000_000, 60);
    let second = env.issuer(3, 1_000_000, 10_000_000, 60);
    let payee = Pubkey::new_unique();
    let destination = env.token_account_of(&payee, 0);
    let payer = env.payer.pubkey();
    let expiry = expiry_of(&env, 10);
    let mint = env.mint;
    let issue = |start| {
        Chain::issue(
            &issuer.key,
            &mint,
            0,
            start,
            50_000_000,
            holder.key.owner(),
            caveats(expiry, 6),
        )
    };

    let handed = issue(0).spend2(&holder.key, 0, second.key.owner(), 10_000_000, 0, 1);
    let chain = handed.spend1_to_account(&second.key, 0, &payee, NO_LOCK, 2);
    env.submit(&record_prefix_ixs(&payer, &issuer, &chain.prefix(1), 0))
        .unwrap(); // record_prefix
    env.submit(&settle_ixs_resumed(
        &env,
        &payer,
        &issuer,
        &chain,
        &destination,
        2,
    ))
    .unwrap(); // settle_note
    assert_eq!(env.balance(&destination), 10_000_000);

    let unsettled = issue(50_000_000);
    env.warp(i64::from(expiry) + i64::from(GRACE) + 1);
    env.submit(&reclaim_ixs(
        &env,
        &payer,
        &issuer,
        &unsettled,
        0,
        &holder.key,
        &holder.wallet_token,
    ))
    .unwrap(); // reclaim_output
    assert_eq!(env.balance(&holder.wallet_token), 50_000_000);

    let record = spent_address(&consumed_outputs(&chain)[0]);
    let closable = buckspay_protocol::window::closable_at(expiry, issuer.lock_until);
    env.warp(closable as i64);
    let close = Instruction {
        program_id: buckspay::ID,
        accounts: vec![
            anchor_lang::solana_program::instruction::AccountMeta::new(record, false),
            anchor_lang::solana_program::instruction::AccountMeta::new(payer, false),
        ],
        data: anchor_lang::InstructionData::data(&buckspay::instruction::CloseSpent {}),
    };
    env.submit(&[close]).unwrap(); // close_spent
    assert!(env.svm.get_account(&record).is_none());
}
