//! The devices a previous build of the program created stay valid across an upgrade: they are
//! refused by every instruction but the migration, which makes them usable without changing the
//! first 41 bytes. Needs that previous build, so it runs through `scripts/upgrade-test.sh`.
#![cfg(feature = "devnet")]

mod common;
use anchor_lang::Discriminator;
use common::*;

const NEW: &[u8] = include_bytes!(concat!(
    env!("CARGO_TARGET_TMPDIR"),
    "/../deploy/buckspay.so"
));

fn previous_build() -> Vec<u8> {
    let path = std::env::var("PREVIOUS_PROGRAM")
        .expect("PREVIOUS_PROGRAM is the path of the previous build; run scripts/upgrade-test.sh");
    std::fs::read(path).unwrap()
}

#[test]
#[ignore = "needs the previous build: run scripts/upgrade-test.sh"]
fn a_device_of_the_previous_build_migrates_and_works() {
    let mut env = Env::new(TokenKind::Classic);
    let user = env.unregistered_user(1_000);
    let key = user.key.sec1();
    let w = user.wallet.pubkey();
    env.svm.airdrop(&w, 10_000_000_000).unwrap();

    // The previous build registers the device: 41 bytes.
    env.svm
        .add_program(buckspay::ID, &previous_build())
        .unwrap();
    env.send(
        &user.wallet,
        &[user.key.binding(&w), register_ix(&user, &w)],
    )
    .unwrap();
    let before = env.svm.get_account(&device_address(&key)).unwrap();
    assert_eq!(before.data.len(), 41);

    // The program is replaced by the new build.
    env.svm.add_program(buckspay::ID, NEW).unwrap();
    let until = env.now() + MIN_LOCK + 86_400;
    let create = create_lock_ix(&env, &user, &w, args_for(&user, 0, 100, 400, until), None);
    let snapshot = env.snapshot();
    let err = env
        .send(&user.wallet, std::slice::from_ref(&create))
        .unwrap_err();
    assert_eq!(
        err,
        program_error(0, 3003),
        "AccountDidNotDeserialize before the migration"
    );
    assert_eq!(env.snapshot(), snapshot);

    env.send(&user.wallet, &[migrate_ix(&w, key)]).unwrap();
    let after = env.svm.get_account(&device_address(&key)).unwrap();
    assert_eq!(
        after.data[..41],
        before.data[..],
        "the first 41 bytes are untouched"
    );
    assert_eq!(env.device(&key).wallet, w);

    env.send(&user.wallet, &[create]).unwrap();
    let lock = Lock::at(&user, 0, 100, 400, until);
    env.warp(i64::from(until) + i64::from(CLAIM_WINDOW));
    env.send(
        &user.wallet,
        &[withdraw_ix(&env, &user, &lock, &user.token)],
    )
    .unwrap();
    assert_eq!(env.balance(&user.token), 1_000);

    // A new key still registers and gets the new size.
    let other = user.with_key(DeviceKey::new(0x77));
    env.send(
        &user.wallet,
        &[other.key.binding(&w), register_ix(&other, &w)],
    )
    .unwrap();
    assert_eq!(
        env.svm
            .get_account(&device_address(&other.key.sec1()))
            .unwrap()
            .data
            .len(),
        49
    );
}

#[test]
fn what_old_clients_depend_on_is_unchanged() {
    assert_eq!(
        Device::DISCRIMINATOR,
        [0x99, 0xf8, 0x17, 0x27, 0x53, 0x2d, 0x44, 0x80]
    );
    assert_eq!(
        buckspay::instruction::RegisterDevice::DISCRIMINATOR,
        [0xd2, 0x97, 0x38, 0x44, 0x16, 0x9e, 0x5a, 0xc1]
    );
    assert_eq!(BuckspayError::DeviceKey as u32 + 6000, 6000);
    assert_eq!(BuckspayError::DeviceBinding as u32 + 6000, 6001);
}
