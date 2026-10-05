mod common;
use buckspay_protocol::{
    cluster::MAINNET_GENESIS_HASH,
    device::{device_binding_envelope, device_rotation_envelope},
    hash::{domain, purpose},
};
use common::*;
use solana_secp256r1_program::new_secp256r1_instruction_with_signature;

const WEEK: i64 = ROTATION_DELAY as i64;
const SIGNATURE: u64 = 5_000;

fn request(
    env: &mut Env,
    user: &User,
    new: &Keypair,
    counter: u32,
) -> Result<Landed, TransactionError> {
    let w = user.wallet.pubkey();
    let ixs = request_ix(env, user, &new.pubkey(), &w, counter); // [verification, request]
    env.send_signed(&w, &ixs, &[&user.wallet, new])
}

#[test]
fn the_wallet_changes_only_after_the_delay_and_then_only_the_new_wallet_withdraws() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + 86_400);
    let new = env.funded_keypair();
    let t0 = env.now() as i64;

    request(&mut env, &user, &new, 0).unwrap();
    let pending = env.rotation(&user.key.sec1());
    assert_eq!(
        (pending.wallet, pending.payer),
        (new.pubkey(), user.wallet.pubkey())
    );
    assert_eq!(pending.effective_at as i64, t0 + WEEK);
    assert_eq!(env.device(&user.key.sec1()).rotations, 1);
    assert_eq!(
        env.device(&user.key.sec1()).wallet,
        user.wallet.pubkey(),
        "nothing changed yet"
    );

    env.warp(t0 + WEEK - 1);
    let apply = apply_ix(&user.key.sec1(), &user.wallet.pubkey());
    let err = env
        .send_signed(&new.pubkey(), std::slice::from_ref(&apply), &[&new])
        .unwrap_err();
    assert_eq!(
        err,
        program_error(0, 6000 + BuckspayError::RotationNotReady as u32)
    );

    env.warp(t0 + WEEK);
    let before = env.lamports(&user.wallet.pubkey());
    env.send_signed(&new.pubkey(), &[apply], &[&new]).unwrap(); // anyone applies
    assert_eq!(env.device(&user.key.sec1()).wallet, new.pubkey());
    assert!(env
        .svm
        .get_account(&rotation_address(&user.key.sec1()))
        .is_none());
    assert_eq!(
        env.lamports(&user.wallet.pubkey()) - before,
        env.rent(77),
        "rent returns to the payer"
    );

    // After the lock's window only the new wallet can withdraw.
    env.warp(i64::from(lock.until) + i64::from(CLAIM_WINDOW));
    let old_try = withdraw_ix(&env, &user, &lock, &user.token);
    let err = env
        .send_signed(&user.wallet.pubkey(), &[old_try], &[&user.wallet])
        .unwrap_err();
    assert_eq!(
        err,
        TransactionError::InstructionError(0, InstructionError::Custom(2001))
    ); // ConstraintHasOne
    let dest = env.new_token_account(&new.pubkey());
    let as_new = User {
        wallet: new.insecure_clone(),
        key: user.key.clone(),
        token: dest,
    };
    let ix = withdraw_ix(&env, &as_new, &lock, &dest);
    env.send_signed(&new.pubkey(), &[ix], &[&new]).unwrap();
    assert_eq!(env.balance(&dest), 500);
}

#[test]
fn a_stolen_device_key_cannot_move_the_wallet_while_the_wallet_cancels() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + 86_400);
    let attacker = env.funded_keypair();
    let t0 = env.now() as i64;

    // The attacker holds the device key and signs a rotation to their own wallet.
    let atk_ixs = request_ix(&env, &user, &attacker.pubkey(), &attacker.pubkey(), 0);
    env.send_signed(&attacker.pubkey(), &atk_ixs, &[&attacker])
        .unwrap();

    // The wallet sees it and cancels with one signature; the attacker cannot cancel and cannot apply early.
    let cancel = cancel_ix(&user.key.sec1(), &user.wallet.pubkey(), &attacker.pubkey());
    let as_wallet = cancel_ix(&user.key.sec1(), &attacker.pubkey(), &attacker.pubkey());
    let err = env
        .send_signed(&attacker.pubkey(), &[as_wallet], &[&attacker])
        .unwrap_err();
    assert_eq!(
        err,
        TransactionError::InstructionError(0, InstructionError::Custom(2001))
    );
    env.warp(t0 + WEEK - 1);
    env.send_signed(&user.wallet.pubkey(), &[cancel], &[&user.wallet])
        .unwrap();
    assert!(env
        .svm
        .get_account(&rotation_address(&user.key.sec1()))
        .is_none());
    assert_eq!(env.device(&user.key.sec1()).wallet, user.wallet.pubkey());

    // The attacker's next attempt needs the next counter value: the first signature is dead.
    let replay = request_ix(&env, &user, &attacker.pubkey(), &attacker.pubkey(), 0);
    let err = env
        .send_signed(&attacker.pubkey(), &replay, &[&attacker])
        .unwrap_err();
    assert_eq!(
        err,
        program_error(1, 6000 + BuckspayError::RotationBinding as u32)
    );

    // The funds were never at risk.
    env.warp(i64::from(lock.until) + i64::from(CLAIM_WINDOW));
    let ix = withdraw_ix(&env, &user, &lock, &user.token);
    env.send_signed(&user.wallet.pubkey(), &[ix], &[&user.wallet])
        .unwrap();
    assert_eq!(env.balance(&user.token), 1_000);
}

#[test]
fn a_used_signature_never_replays_even_when_the_wallet_comes_back() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let b = env.funded_keypair();
    let t = env.now() as i64;

    request(&mut env, &user, &b, 0).unwrap(); // A -> B (counter 0)
    env.warp(t + WEEK);
    env.send_signed(
        &b.pubkey(),
        &[apply_ix(&user.key.sec1(), &user.wallet.pubkey())],
        &[&b],
    )
    .unwrap();

    // B -> A (counter 1), signed by the device key and by A.
    let ixs = request_ix(&env, &user, &user.wallet.pubkey(), &b.pubkey(), 1);
    env.send_signed(&b.pubkey(), &ixs, &[&b, &user.wallet])
        .unwrap();
    env.warp(t + 2 * WEEK);
    env.send_signed(
        &b.pubkey(),
        &[apply_ix(&user.key.sec1(), &b.pubkey())],
        &[&b],
    )
    .unwrap();
    assert_eq!(env.device(&user.key.sec1()).wallet, user.wallet.pubkey());

    // The wallet is A again; the public A -> B signature (counter 0) replays with B's cooperation.
    let before = env.snapshot();
    let replay = request_ix(&env, &user, &b.pubkey(), &b.pubkey(), 0);
    let err = env.send_signed(&b.pubkey(), &replay, &[&b]).unwrap_err();
    assert_eq!(
        err,
        program_error(1, 6000 + BuckspayError::RotationBinding as u32)
    );
    assert_eq!(env.snapshot(), before);
    assert_eq!(env.device(&user.key.sec1()).rotations, 2);
}

/// Sends `[verification, request]` signed by the wallet and the new wallet.
fn request_with(
    env: &mut Env,
    user: &User,
    new: &Keypair,
    verification: Instruction,
) -> Result<Landed, TransactionError> {
    let w = user.wallet.pubkey();
    let request = request_only_ix(&user.key.sec1(), &new.pubkey(), &w);
    env.send_signed(&w, &[verification, request], &[&user.wallet, new])
}

#[test]
fn request_needs_the_new_wallets_signature() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let new = Keypair::new();
    let w = user.wallet.pubkey();
    let mut ixs = request_ix(&env, &user, &new.pubkey(), &w, 0);
    ixs[1].accounts[0].is_signer = false;
    let before = env.snapshot();
    let err = env.send_signed(&w, &ixs, &[&user.wallet]).unwrap_err();
    assert_eq!(err, program_error(1, 3010)); // AccountNotSigner
    assert_eq!(env.snapshot(), before);
}

#[test]
fn request_to_the_current_wallet_is_refused() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let w = user.wallet.pubkey();
    let ixs = request_ix(&env, &user, &w, &w, 0);
    let before = env.snapshot();
    let err = env.send_signed(&w, &ixs, &[&user.wallet]).unwrap_err();
    assert_eq!(
        err,
        program_error(1, 6000 + BuckspayError::SameWallet as u32)
    );
    assert_eq!(env.snapshot(), before);
}

#[test]
fn request_for_an_unregistered_key_is_refused() {
    let mut env = Env::new(TokenKind::Classic);
    let ghost = env.unregistered_user(0);
    let new = env.funded_keypair();
    let n = new.pubkey();
    let ixs = vec![
        ghost.key.rotation(&ghost.wallet.pubkey(), &n, 0),
        request_only_ix(&ghost.key.sec1(), &n, &n),
    ];
    let err = env.send(&new, &ixs).unwrap_err();
    assert_eq!(err, program_error(1, 3012)); // AccountNotInitialized
}

/// The devices created before the counters existed fail every instruction but the migration.
#[cfg(feature = "devnet")]
#[test]
fn request_for_an_unmigrated_41_byte_device_is_refused_until_it_is_migrated() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let new = env.funded_keypair();
    let key = user.key.sec1();
    env.shrink_device_to_legacy(&key);
    let w = user.wallet.pubkey();
    let ixs = request_ix_for_legacy(&user, &new.pubkey(), &w);
    let before = env.snapshot();
    let err = env
        .send_signed(&w, &ixs, &[&user.wallet, &new])
        .unwrap_err();
    assert_eq!(err, program_error(1, 3003)); // AccountDidNotDeserialize
    assert_eq!(env.snapshot(), before);

    env.send(&user.wallet, &[migrate_ix(&w, key)]).unwrap();
    let ixs = request_ix(&env, &user, &new.pubkey(), &w, 0);
    env.send_signed(&w, &ixs, &[&user.wallet, &new]).unwrap();
}

#[cfg(feature = "devnet")]
fn request_ix_for_legacy(user: &User, new: &Pubkey, payer: &Pubkey) -> Vec<Instruction> {
    vec![
        user.key.rotation(&user.wallet.pubkey(), new, 0),
        request_only_ix(&user.key.sec1(), new, payer),
    ]
}

#[test]
fn request_needs_a_verification_of_exactly_these_values() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let new = env.funded_keypair();
    let (w, n, key) = (user.wallet.pubkey(), new.pubkey(), user.key.sec1());
    let elsewhere = Keypair::new().pubkey();
    let device_domain = domain(
        purpose::DEVICE,
        &buckspay::GENESIS_HASH,
        &buckspay::ID.to_bytes(),
    );
    let signed = |message: [u8; 96]| {
        new_secp256r1_instruction_with_signature(&message, &user.key.sign(&message), &key)
    };
    let rotation = |domain: &[u8; 32], old: &Pubkey, new: &Pubkey, counter: u32| {
        signed(
            device_rotation_envelope(domain, &old.to_bytes(), &new.to_bytes(), &key, counter)
                .unwrap(),
        )
    };

    let mut trailing = user.key.rotation(&w, &n, 0);
    trailing.data.push(0);
    let other_key = DeviceKey::new(99);
    let by_another_key = {
        let message = buckspay::rotation_envelope(&w, &n, &key, 0).unwrap();
        new_secp256r1_instruction_with_signature(
            &message,
            &other_key.sign(&message),
            &other_key.sec1(),
        )
    };
    let cases: Vec<(&str, Instruction)> = vec![
        (
            "another old wallet",
            rotation(&device_domain, &elsewhere, &n, 0),
        ),
        (
            "another new wallet",
            rotation(&device_domain, &w, &elsewhere, 0),
        ),
        ("another key's signature", by_another_key),
        ("another counter", rotation(&device_domain, &w, &n, 1)),
        (
            "another cluster's domain",
            rotation(
                &domain(
                    purpose::DEVICE,
                    &MAINNET_GENESIS_HASH,
                    &buckspay::ID.to_bytes(),
                ),
                &w,
                &n,
                0,
            ),
        ),
        (
            "another program's domain",
            rotation(
                &domain(purpose::DEVICE, &buckspay::GENESIS_HASH, &[7; 32]),
                &w,
                &n,
                0,
            ),
        ),
        (
            "the device binding of the same wallet",
            signed(device_binding_envelope(&device_domain, &w.to_bytes(), &key).unwrap()),
        ),
        ("trailing bytes", trailing),
    ];
    for (name, verification) in cases {
        let before = env.snapshot();
        let err = request_with(&mut env, &user, &new, verification).unwrap_err();
        assert_eq!(
            err,
            program_error(1, 6000 + BuckspayError::RotationBinding as u32),
            "{name}"
        );
        assert_eq!(env.snapshot(), before, "{name}");
    }

    // A verification after the request, and none at all.
    let request = request_only_ix(&key, &n, &w);
    let late = vec![request.clone(), user.key.rotation(&w, &n, 0)];
    let before = env.snapshot();
    let err = env
        .send_signed(&w, &late, &[&user.wallet, &new])
        .unwrap_err();
    assert_eq!(
        err,
        program_error(0, 6000 + BuckspayError::RotationBinding as u32),
        "verification after the request"
    );
    let err = env
        .send_signed(&w, &[request], &[&user.wallet, &new])
        .unwrap_err();
    assert_eq!(
        err,
        program_error(0, 6000 + BuckspayError::RotationBinding as u32),
        "no verification"
    );
    assert_eq!(env.snapshot(), before);

    // A high-S signature never reaches the program: the secp256r1 precompile refuses it.
    let message = buckspay::rotation_envelope(&w, &n, &key, 0).unwrap();
    let high_s =
        new_secp256r1_instruction_with_signature(&message, &user.key.high_s(&message), &key);
    let err = request_with(&mut env, &user, &new, high_s).unwrap_err();
    assert!(
        matches!(
            err,
            TransactionError::InstructionError(0, InstructionError::Custom(_))
        ),
        "{err:?}"
    );
    assert_eq!(env.snapshot(), before);
    assert!(env.svm.get_account(&rotation_address(&key)).is_none());
}

#[test]
fn unrelated_extra_verifications_do_not_block_a_valid_request() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let new = env.funded_keypair();
    let w = user.wallet.pubkey();
    let mut ixs = request_ix(&env, &user, &new.pubkey(), &w, 0);
    ixs.insert(0, user.key.rotation(&w, &Keypair::new().pubkey(), 7));
    env.send_signed(&w, &ixs, &[&user.wallet, &new]).unwrap();
    assert_eq!(env.rotation(&user.key.sec1()).wallet, new.pubkey());
}

#[test]
fn a_binding_signature_is_not_a_rotation() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let new = env.funded_keypair();
    let w = user.wallet.pubkey();
    let binding = user.key.binding(&w);
    let err = request_with(&mut env, &user, &new, binding).unwrap_err();
    assert_eq!(
        err,
        program_error(1, 6000 + BuckspayError::RotationBinding as u32)
    );
}

#[test]
fn a_second_request_while_pending_fails() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let new = env.funded_keypair();
    let other = env.funded_keypair();
    request(&mut env, &user, &new, 0).unwrap();
    let before = env.snapshot();
    let w = user.wallet.pubkey();
    let ixs = request_ix(&env, &user, &other.pubkey(), &w, 1);
    let err = env
        .send_signed(&w, &ixs, &[&user.wallet, &other])
        .unwrap_err();
    assert_eq!(
        err,
        program_error(1, 0),
        "the rotation account already exists"
    );
    assert_eq!(
        env.snapshot(),
        before,
        "the counter and the pending record are unchanged"
    );
}

#[test]
fn only_the_current_wallet_cancels() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let new = env.funded_keypair();
    let stranger = env.funded_keypair();
    let key = user.key.sec1();
    let w = user.wallet.pubkey();
    request(&mut env, &user, &new, 0).unwrap();
    for signer in [&new, &stranger] {
        let ix = cancel_ix(&key, &signer.pubkey(), &w);
        let err = env.send(signer, &[ix]).unwrap_err();
        assert_eq!(err, program_error(0, 2001), "ConstraintHasOne");
    }
    let before = env.lamports(&w);
    env.send_signed(
        &new.pubkey(),
        &[cancel_ix(&key, &w, &w)],
        &[&new, &user.wallet],
    )
    .unwrap();
    assert_eq!(
        env.lamports(&w) - before,
        env.rent(77),
        "the rent goes back to whoever paid it"
    );
    assert_eq!(
        env.device(&key).rotations,
        1,
        "a cancel does not rewind the counter"
    );
}

#[test]
fn cancel_after_the_delay_but_before_apply_still_works() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let new = env.funded_keypair();
    let key = user.key.sec1();
    let t0 = i64::from(env.now());
    request(&mut env, &user, &new, 0).unwrap();
    env.warp(t0 + WEEK + 86_400);
    let w = user.wallet.pubkey();
    env.send(&user.wallet, &[cancel_ix(&key, &w, &w)]).unwrap();
    assert!(env.svm.get_account(&rotation_address(&key)).is_none());
    assert_eq!(env.device(&key).wallet, w);
}

#[test]
fn apply_is_idempotent_by_construction() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let new = env.funded_keypair();
    let key = user.key.sec1();
    let t0 = i64::from(env.now());
    request(&mut env, &user, &new, 0).unwrap();
    env.warp(t0 + WEEK);
    let apply = apply_ix(&key, &user.wallet.pubkey());
    env.send_signed(&new.pubkey(), std::slice::from_ref(&apply), &[&new])
        .unwrap();
    let before = env.snapshot();
    let err = env
        .send_signed(&new.pubkey(), &[apply], &[&new])
        .unwrap_err();
    assert_eq!(err, program_error(0, 3012), "the rotation account is gone");
    assert_eq!(env.snapshot(), before);
    assert_eq!(env.device(&key).wallet, new.pubkey());
}

#[test]
fn rotation_does_not_touch_existing_locks() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + 86_400);
    let new = env.funded_keypair();
    let t0 = i64::from(env.now());
    let bytes = |env: &Env| {
        (
            env.svm.get_account(&lock.address).unwrap(),
            env.svm.get_account(&lock.ledger).unwrap(),
        )
    };
    let before = bytes(&env);
    request(&mut env, &user, &new, 0).unwrap();
    env.warp(t0 + WEEK);
    env.send_signed(
        &new.pubkey(),
        &[apply_ix(&user.key.sec1(), &user.wallet.pubkey())],
        &[&new],
    )
    .unwrap();
    assert_eq!(
        bytes(&env),
        before,
        "Lock and Ledger are byte for byte what they were"
    );
}

#[test]
fn a_rotation_in_flight_does_not_block_create_lock_or_withdraw_by_the_current_wallet() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.user(1_000);
    let lock = lock_for(&mut env, &user, 100, 400, MIN_LOCK + 86_400);
    let new = env.funded_keypair();
    request(&mut env, &user, &new, 0).unwrap();
    let second = lock_for(&mut env, &user, 10, 10, MIN_LOCK + 86_400);
    env.warp(i64::from(lock.until.max(second.until)) + i64::from(CLAIM_WINDOW));
    let ix = withdraw_ix(&env, &user, &lock, &user.token);
    env.send(&user.wallet, &[ix]).unwrap();
    assert_eq!(env.balance(&user.token), 1_000 - 500 - 20 + 500);
}

#[test]
fn sponsored_rotation_pays_nothing_from_the_wallets_sol() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.unregistered_user(1_000);
    let s = env.sponsor.pubkey();
    let until = env.now() + MIN_LOCK + 86_400;
    let ixs = onboard_ixs(&env, &user, &s, args_for(&user, 0, 100, 400, until), None);
    env.send_signed(&s, &ixs, &[&env.sponsor.insecure_clone(), &user.wallet])
        .unwrap();
    let new = Keypair::new();
    let key = user.key.sec1();
    let t0 = i64::from(env.now());

    // A request pays three signatures (the sponsor's, the new wallet's and the device key's), a
    // cancel two, an apply one; the rotation's rent comes back each time.
    let before = env.lamports(&s);
    let ixs = request_ix(&env, &user, &new.pubkey(), &s, 0);
    env.send_signed(&s, &ixs, &[&env.sponsor.insecure_clone(), &new])
        .unwrap();
    assert_eq!(before - env.lamports(&s), env.rent(77) + 3 * SIGNATURE);
    let cancel = cancel_ix(&key, &user.wallet.pubkey(), &s);
    env.send_signed(
        &s,
        &[cancel],
        &[&env.sponsor.insecure_clone(), &user.wallet],
    )
    .unwrap();
    assert_eq!(
        before - env.lamports(&s),
        (3 + 2) * SIGNATURE,
        "the rent came back"
    );

    let ixs = request_ix(&env, &user, &new.pubkey(), &s, 1);
    env.send_signed(&s, &ixs, &[&env.sponsor.insecure_clone(), &new])
        .unwrap();
    env.warp(t0 + WEEK);
    env.send_signed(&s, &[apply_ix(&key, &s)], &[&env.sponsor.insecure_clone()])
        .unwrap();
    assert_eq!(before - env.lamports(&s), (3 + 2 + 3 + 1) * SIGNATURE);
    for wallet in [user.wallet.pubkey(), new.pubkey()] {
        assert_eq!(env.lamports(&wallet), 0);
    }
}
