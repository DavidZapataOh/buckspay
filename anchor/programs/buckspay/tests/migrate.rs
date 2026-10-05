#![cfg(feature = "devnet")]

mod common;
use anchor_lang::{AccountDeserialize, Discriminator};
use base64::Engine;
use buckspay::Device;
use common::*;

/// The 41-byte accounts `register_device` created on devnet before the counters existed (read with
/// `getProgramAccounts`, dataSize 41).
fn devnet_devices() -> Vec<Vec<u8>> {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("fixtures/devnet-devices-41b.json")).unwrap();
    fixtures
        .iter()
        .map(|fixture| {
            base64::engine::general_purpose::STANDARD
                .decode(fixture["data"].as_str().unwrap())
                .unwrap()
        })
        .collect()
}

fn legacy_account(env: &Env, data: Vec<u8>, owner: Pubkey) -> Account {
    Account {
        lamports: env.rent(41),
        data,
        owner,
        executable: false,
        rent_epoch: 0,
    }
}

fn bump_of(key: &[u8; 33]) -> u8 {
    Pubkey::find_program_address(
        &[buckspay::DEVICE_SEED, &key[..1], &key[1..]],
        &buckspay::ID,
    )
    .1
}

/// Plants a real devnet account's bytes at the address of `key`'s device, with the bump that
/// address really has (the real keys are not public, so a test key stands in).
fn plant(env: &mut Env, key: &[u8; 33], original: &[u8]) -> Vec<u8> {
    let mut data = original.to_vec();
    data[40] = bump_of(key);
    let account = legacy_account(env, data.clone(), buckspay::ID);
    env.set_account(device_address(key), account);
    data
}

#[test]
fn the_real_devnet_accounts_use_the_discriminator_and_layout_of_the_new_device() {
    let accounts = devnet_devices();
    assert_eq!(accounts.len(), 4);
    for data in &accounts {
        assert_eq!(data.len(), 41);
        assert_eq!(data[..8], *Device::DISCRIMINATOR);
    }
}

#[test]
fn a_real_41_byte_device_does_not_deserialize_as_the_new_layout() {
    let accounts = devnet_devices();
    assert!(Device::try_deserialize(&mut accounts[0].as_slice()).is_err());
}

#[test]
fn migrate_grows_every_real_account_keeps_its_first_41_bytes_and_zeroes_the_counters() {
    let mut env = Env::new(TokenKind::Classic);
    let payer = env.funded_keypair();
    for (i, original) in devnet_devices().iter().enumerate() {
        let key = {
            let mut key = [i as u8 + 1; 33];
            key[0] = 2;
            key
        };
        let planted = plant(&mut env, &key, original);
        let before = env.lamports(&payer.pubkey());
        env.send(&payer, &[migrate_ix(&payer.pubkey(), key)])
            .unwrap();
        let account = env.svm.get_account(&device_address(&key)).unwrap();
        assert_eq!(account.data.len(), 49);
        assert_eq!(
            account.data[..41],
            planted[..],
            "wallet, bump and discriminator untouched"
        );
        assert_eq!(
            account.data[41..],
            [0u8; 8],
            "next_lock_seq and rotations start at zero"
        );
        assert_eq!(account.lamports, env.rent(49));
        assert_eq!(
            before - env.lamports(&payer.pubkey()),
            env.rent(49) - env.rent(41) + 5_000,
            "the payer paid exactly the rent difference and one signature"
        );
        let device = env.device(&key);
        assert_eq!((device.next_lock_seq, device.rotations), (0, 0));
        assert_eq!(device.bump, bump_of(&key));
    }
}

#[test]
fn a_second_migration_and_a_new_style_device_are_refused() {
    let mut env = Env::new(TokenKind::Classic);
    let payer = env.funded_keypair();
    let key = {
        let mut key = [9u8; 33];
        key[0] = 3;
        key
    };
    plant(&mut env, &key, &devnet_devices()[0]);
    env.send(&payer, &[migrate_ix(&payer.pubkey(), key)])
        .unwrap();
    let before = env.svm.get_account(&device_address(&key)).unwrap();
    assert!(env
        .send(&payer, &[migrate_ix(&payer.pubkey(), key)])
        .is_err());
    assert_eq!(env.svm.get_account(&device_address(&key)).unwrap(), before);
}

#[test]
fn migration_refuses_accounts_that_are_not_devices() {
    let mut env = Env::new(TokenKind::Classic);
    let payer = env.funded_keypair();
    let key = {
        let mut key = [5u8; 33];
        key[0] = 2;
        key
    };
    let address = device_address(&key);
    let mut good = devnet_devices()[0].clone();
    good[40] = bump_of(&key);
    let cases = vec![
        (
            "wrong owner",
            legacy_account(&env, good.clone(), Pubkey::new_unique()),
        ),
        ("wrong discriminator", {
            let mut data = good.clone();
            data[0] ^= 1;
            legacy_account(&env, data, buckspay::ID)
        }),
        ("wrong bump", {
            let mut data = good.clone();
            data[40] = bump_of(&key).wrapping_sub(1);
            legacy_account(&env, data, buckspay::ID)
        }),
        (
            "wrong length",
            legacy_account(&env, good[..40].to_vec(), buckspay::ID),
        ),
        ("missing account", Account::default()),
    ];
    for (label, account) in cases {
        env.set_account(address, account);
        assert!(
            env.send(&payer, &[migrate_ix(&payer.pubkey(), key)])
                .is_err(),
            "{label}"
        );
    }
}
