//! Runs in both profiles (`--features devnet` and `--features devnet,short-windows`): every time is
//! derived from the constants.
mod common;
use common::*;

const DAY: u32 = 24 * 60 * 60;

fn at(env: &mut Env, unix: i64) {
    env.warp(unix);
}

#[test]
fn every_boundary_uses_the_constants() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(10_000);
    let w = user.wallet.pubkey();
    let now = i64::from(env.now());

    // create_lock: now + MIN_LOCK and now + MAX_LOCK are accepted, one second outside is refused.
    for (until, ok) in [
        (now + i64::from(MIN_LOCK) - 1, false),
        (now + i64::from(MIN_LOCK), true),
        (now + i64::from(MAX_LOCK), true),
        (now + i64::from(MAX_LOCK) + 1, false),
    ] {
        let until = u32::try_from(until).unwrap();
        assert_eq!(
            env.try_lock(&user, 1, 1, until).is_ok(),
            ok,
            "lock_until = now + {}",
            i64::from(until) - now
        );
    }

    // withdraw at lock_until + CLAIM_WINDOW - 1 is refused and at + 0 accepted; release, close likewise.
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    let until = i64::from(lock.until);
    let withdraw =
        |env: &mut Env| env.send(&user.wallet, &[withdraw_ix(env, &user, &lock, &user.token)]);
    at(&mut env, until + i64::from(CLAIM_WINDOW) - 1);
    assert_eq!(
        withdraw(&mut env).unwrap_err(),
        program_error(0, 6000 + BuckspayError::WithdrawTooEarly as u32)
    );
    at(&mut env, until + i64::from(CLAIM_WINDOW));
    withdraw(&mut env).unwrap();

    // A second lock for release and close.
    let other = lock_for(&mut env, &user, 100, 400, MIN_LOCK + DAY);
    let until = i64::from(other.until);
    let release_at = until + i64::from(CLAIM_WINDOW) + i64::from(RELEASE_DELAY);
    at(&mut env, release_at - 1);
    assert_eq!(
        env.try_release(&user, &other).unwrap_err(),
        program_error(0, 6000 + BuckspayError::ReleaseTooEarly as u32)
    );
    at(&mut env, release_at);
    env.try_release(&user, &other).unwrap();

    let close_at = until + i64::from(RECORD_TTL);
    let close = close_ix(&other, user.key.sec1(), &w);
    at(&mut env, close_at - 1);
    assert_eq!(
        env.send(&user.wallet, std::slice::from_ref(&close))
            .unwrap_err(),
        program_error(0, 6000 + BuckspayError::CloseTooEarly as u32)
    );
    at(&mut env, close_at);
    env.send(&user.wallet, &[close]).unwrap();
}

#[test]
fn the_rotation_applies_at_its_effective_time() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let new = env.funded_keypair();
    let w = user.wallet.pubkey();
    let t0 = i64::from(env.now());
    let ixs = request_ix(&env, &user, &new.pubkey(), &w, 0);
    env.send_signed(&w, &ixs, &[&user.wallet, &new]).unwrap();
    assert_eq!(
        i64::from(env.rotation(&user.key.sec1()).effective_at),
        t0 + i64::from(ROTATION_DELAY)
    );
    let apply = apply_ix(&user.key.sec1(), &w);
    at(&mut env, t0 + i64::from(ROTATION_DELAY) - 1);
    assert_eq!(
        env.send(&new, std::slice::from_ref(&apply)).unwrap_err(),
        program_error(0, 6000 + BuckspayError::RotationNotReady as u32)
    );
    at(&mut env, t0 + i64::from(ROTATION_DELAY));
    env.send(&new, &[apply]).unwrap();
}

#[test]
fn ordering_holds_in_both_profiles() {
    use std::hint::black_box;
    assert!(black_box(RECORD_TTL) >= CLAIM_WINDOW);
    assert!(black_box(MIN_LOCK) > buckspay_protocol::GRACE + buckspay_protocol::CHALLENGE);
    assert!(black_box(RELEASE_DELAY) > 0 && CLAIM_WINDOW + RELEASE_DELAY > CLAIM_WINDOW);
    assert!(black_box(ROTATION_DELAY) > 0);
}

#[test]
fn the_program_id_belongs_to_its_profile() {
    let committed: serde_json::Value = serde_json::from_str(include_str!(
        "../../../crates/protocol/tests/vectors/v1.json"
    ))
    .unwrap();
    let profiles = &committed["profiles"];
    let (own, other) = if cfg!(feature = "short-windows") {
        (
            &profiles["short"]["programId"],
            &profiles["production"]["programIds"]["devnet"],
        )
    } else {
        (
            &profiles["production"]["programIds"]["devnet"],
            &profiles["short"]["programId"],
        )
    };
    assert_eq!(own.as_str().unwrap(), buckspay::ID.to_string());
    let declared = if cfg!(feature = "short-windows") {
        buckspay_protocol::profile::SHORT_PROGRAM_ID
    } else {
        buckspay_protocol::profile::PRODUCTION_DEVNET_PROGRAM_ID
    };
    assert_eq!(declared, buckspay::ID.to_string());
    assert_ne!(other.as_str().unwrap(), buckspay::ID.to_string());
}
