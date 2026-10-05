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
