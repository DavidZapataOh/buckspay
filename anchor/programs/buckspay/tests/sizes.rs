//! Every transaction the app and the gateway send fits a legacy transaction with room to spare:
//! none of them needs Transaction V1. Each carries the compute-unit limit and price the gateway
//! sets, and is signed the way a sponsored transaction is.
mod common;
use common::*;
use solana_compute_budget_interface::ComputeBudgetInstruction;

fn with_limits(ixs: Vec<Instruction>) -> Vec<Instruction> {
    let mut all = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(100_000),
        ComputeBudgetInstruction::set_compute_unit_price(1_000),
    ];
    all.extend(ixs);
    all
}

fn size(name: &str, landed: Landed, ceiling: usize) {
    println!("{name}: {} B / {ceiling} B", landed.size);
    assert!(landed.size <= ceiling, "{name}: {} B", landed.size);
    assert!(landed.size < 1_232);
}

#[test]
fn sizes_fit_a_legacy_transaction_with_room() {
    let mut env = Env::new(TokenKind::Classic);
    let sponsor = env.sponsor.insecure_clone();
    let s = sponsor.pubkey();
    let until = env.now() + MIN_LOCK + 86_400;

    let user = env.unregistered_user(1_000_000_000);
    let args = args_for(&user, 0, 20_000_000, 100_000_000, until);
    let ixs = with_limits(onboard_ixs(&env, &user, &s, args, None));
    size(
        "onboarding",
        env.send_signed(&s, &ixs, &[&sponsor, &user.wallet])
            .unwrap(),
        1_100,
    );

    let fee_user = env.unregistered_user(1_000_000_000);
    let mut args = args_for(&fee_user, 0, 20_000_000, 100_000_000, until);
    args.sponsor_fee = 150_000;
    let ixs = with_limits(onboard_ixs(
        &env,
        &fee_user,
        &s,
        args,
        Some(env.sponsor_token),
    ));
    size(
        "onboarding with the fee lever",
        env.send_signed(&s, &ixs, &[&sponsor, &fee_user.wallet])
            .unwrap(),
        1_130,
    );

    let ixs = with_limits(vec![create_lock_ix(
        &env,
        &user,
        &s,
        args_for(&user, 1, 100, 400, until),
        None,
    )]);
    size(
        "later lock",
        env.send_signed(&s, &ixs, &[&sponsor, &user.wallet])
            .unwrap(),
        750,
    );

    let second = Lock::at(&user, 1, 100, 400, until);
    let first = Lock::at(&user, 0, 20_000_000, 100_000_000, until);
    env.warp(i64::from(until) + i64::from(CLAIM_WINDOW));
    let ixs = with_limits(vec![withdraw_ix(&env, &user, &first, &user.token)]);
    size(
        "withdraw_lock, sponsored",
        env.send_signed(&s, &ixs, &[&sponsor, &user.wallet])
            .unwrap(),
        700,
    );

    env.warp(i64::from(until) + i64::from(CLAIM_WINDOW) + i64::from(RELEASE_DELAY));
    let ixs = with_limits(vec![release_ix(&env, &user, &second, &user.token, &s)]);
    size(
        "release_lock",
        env.send_signed(&s, &ixs, &[&sponsor]).unwrap(),
        600,
    );
    let ixs = with_limits(vec![close_ix(&second, user.key.sec1(), &s)]);
    size(
        "close_lock",
        env.send_signed(&s, &ixs, &[&sponsor]).unwrap(),
        500,
    );

    let third = lock_with_payer(&mut env, &user, &sponsor, 2);
    env.warp(i64::from(third.until) + i64::from(CLAIM_WINDOW) + i64::from(RELEASE_DELAY));
    let ixs = with_limits(vec![
        release_ix(&env, &user, &third, &user.token, &s),
        close_ix(&third, user.key.sec1(), &s),
    ]);
    size(
        "release_lock + close_lock",
        env.send_signed(&s, &ixs, &[&sponsor]).unwrap(),
        700,
    );

    let new = env.funded_keypair();
    let ixs = with_limits(request_ix(&env, &user, &new.pubkey(), &s, 0));
    size(
        "request_wallet_rotation, sponsored",
        env.send_signed(&s, &ixs, &[&sponsor, &new]).unwrap(),
        850,
    );
    env.warp(i64::from(env.now()) + i64::from(ROTATION_DELAY));
    let ixs = with_limits(vec![apply_ix(&user.key.sec1(), &s)]);
    size(
        "apply_wallet_rotation",
        env.send_signed(&s, &ixs, &[&sponsor]).unwrap(),
        500,
    );
}

/// A lock whose rent `payer` paid, created now with the shortest duration.
fn lock_with_payer(env: &mut Env, user: &User, payer: &Keypair, seq: u32) -> Lock {
    let until = env.now() + MIN_LOCK;
    let ix = create_lock_ix(
        env,
        user,
        &payer.pubkey(),
        args_for(user, seq, 10, 10, until),
        None,
    );
    env.send_signed(&payer.pubkey(), &[ix], &[payer, &user.wallet])
        .unwrap();
    Lock::at(user, seq, 10, 10, until)
}
