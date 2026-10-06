use base64::{Engine, prelude::BASE64_STANDARD};
use buckspay_gateway::hpke::{AEAD_ID, HpkeKeys, KDF_ID, KEM_ID, OpenError, info};
use buckspay_protocol::cluster::{DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH};
use hpke::{
    Kem as _, OpModeS, Serializable, aead::ChaCha20Poly1305, kdf::HkdfSha256, kem::X25519HkdfSha256,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{env, fs, os::unix::fs::PermissionsExt};

type Kem = X25519HkdfSha256;

/// The test key of both fixtures: RFC 9180 `DeriveKeyPair` from 32 bytes of 7.
const IKM: [u8; 32] = [7; 32];
const PURPOSE: &str = "test";
const GATEWAY_FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/hpke-gateway.json"
);
const APP_FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/hpke-app.json");

fn test_key(ikm: [u8; 32]) -> ([u8; 32], <Kem as hpke::Kem>::PublicKey) {
    let (secret, public) = Kem::derive_keypair(&ikm);
    (secret.to_bytes().into(), public)
}

fn plaintext(size: usize) -> Vec<u8> {
    (0..size).map(|i| (i % 251) as u8).collect()
}

fn seal(
    public: &<Kem as hpke::Kem>::PublicKey,
    context: &[u8],
    plaintext: &[u8],
    aad: &[u8],
) -> (Vec<u8>, Vec<u8>) {
    let (encapsulated, ciphertext) = hpke::single_shot_seal::<ChaCha20Poly1305, HkdfSha256, Kem>(
        &OpModeS::Base,
        public,
        context,
        plaintext,
        aad,
    )
    .unwrap();
    (encapsulated.to_bytes().to_vec(), ciphertext)
}

#[test]
fn publishes_the_suite_and_the_current_key_first() {
    let (current, current_public) = test_key([1; 32]);
    let (previous, _) = test_key([2; 32]);
    let keys = HpkeKeys::from_secrets(&[current, previous]).unwrap();
    let published = keys.published();
    assert_eq!(published.len(), 2);
    assert_eq!(
        (
            published[0].kem_id,
            published[0].kdf_id,
            published[0].aead_id
        ),
        (KEM_ID, KDF_ID, AEAD_ID)
    );
    assert_eq!(
        published[0].public_key,
        BASE64_STANDARD.encode(current_public.to_bytes())
    );
    assert_ne!(published[0].key_id, published[1].key_id);
}

#[test]
fn opens_what_was_sealed_for_its_purpose_cluster_and_data_only() {
    let (secret, public) = test_key(IKM);
    let keys = HpkeKeys::from_secrets(&[secret]).unwrap();
    let id = keys.published()[0].key_id;
    let context = info(PURPOSE, &DEVNET_GENESIS_HASH);
    for size in [0, 1, 227, 4096] {
        let (encapsulated, ciphertext) = seal(&public, &context, &plaintext(size), b"aad");
        assert_eq!(
            keys.open(id, &encapsulated, &context, &ciphertext, b"aad"),
            Ok(plaintext(size)),
            "{size} bytes"
        );
        for (name, other_info, aad) in [
            (
                "another purpose",
                info("relay", &DEVNET_GENESIS_HASH),
                b"aad".as_slice(),
            ),
            (
                "another cluster",
                info(PURPOSE, &MAINNET_GENESIS_HASH),
                b"aad".as_slice(),
            ),
            ("other data", context.clone(), b"other".as_slice()),
        ] {
            assert_eq!(
                keys.open(id, &encapsulated, &other_info, &ciphertext, aad),
                Err(OpenError::Refused),
                "{name}"
            );
        }
        assert_eq!(
            keys.open(
                id.wrapping_add(1),
                &encapsulated,
                &context,
                &ciphertext,
                b"aad"
            ),
            Err(OpenError::UnknownKey)
        );
    }
}

/// Rotation: messages sealed to the previous key still open while it is kept.
#[test]
fn opens_with_the_previous_key_during_a_rotation() {
    let (current, _) = test_key([1; 32]);
    let (previous, previous_public) = test_key([2; 32]);
    let keys = HpkeKeys::from_secrets(&[current, previous]).unwrap();
    let previous_id = keys.published()[1].key_id;
    let context = info(PURPOSE, &DEVNET_GENESIS_HASH);
    let (encapsulated, ciphertext) = seal(&previous_public, &context, b"note", b"");
    assert_eq!(
        keys.open(previous_id, &encapsulated, &context, &ciphertext, b""),
        Ok(b"note".to_vec())
    );
    let retired = HpkeKeys::from_secrets(&[current]).unwrap();
    assert_eq!(
        retired.open(previous_id, &encapsulated, &context, &ciphertext, b""),
        Err(OpenError::UnknownKey)
    );
}

#[test]
fn reads_key_files_only_their_owner_can_read() {
    let (secret, _) = test_key([3; 32]);
    let path = env::temp_dir().join(format!("buckspay-hpke-{}.key", std::process::id()));
    fs::write(&path, secret).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(
        HpkeKeys::read(&[&path])
            .err()
            .unwrap()
            .contains("chmod 600")
    );
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        HpkeKeys::read(&[&path]).unwrap().published(),
        HpkeKeys::from_secrets(&[secret]).unwrap().published()
    );
    fs::write(&path, [1, 2, 3]).unwrap();
    assert!(HpkeKeys::read(&[&path]).err().unwrap().contains("32-byte"));
    fs::remove_file(&path).unwrap();
}

/// Messages sealed by the gateway's library, which the app's test opens.
#[test]
fn gateway_fixture_opens_here() {
    let (secret, public) = test_key(IKM);
    let context = info(PURPOSE, &DEVNET_GENESIS_HASH);
    if env::var_os("WRITE_FIXTURE").is_some() {
        let messages: Vec<Value> = [0, 1, 227, 4096]
            .into_iter()
            .map(|size| {
                let (encapsulated, ciphertext) = seal(&public, &context, &plaintext(size), b"aad");
                json!({
                    "size": size,
                    "enc": BASE64_STANDARD.encode(encapsulated),
                    "ciphertext": BASE64_STANDARD.encode(ciphertext),
                })
            })
            .collect();
        let mut text = serde_json::to_string_pretty(&json!({
            "ikm": hex::encode(IKM),
            "purpose": PURPOSE,
            "aad": BASE64_STANDARD.encode(b"aad"),
            "messages": messages,
        }))
        .unwrap();
        text.push('\n');
        fs::write(GATEWAY_FIXTURE, text).unwrap();
    }
    let fixture: Value = serde_json::from_str(
        &fs::read_to_string(GATEWAY_FIXTURE)
            .expect("run: WRITE_FIXTURE=1 cargo test --test hpke gateway_fixture"),
    )
    .unwrap();
    let keys = HpkeKeys::from_secrets(&[secret]).unwrap();
    let id = keys.published()[0].key_id;
    for message in fixture["messages"].as_array().unwrap() {
        let field = |name: &str| {
            BASE64_STANDARD
                .decode(message[name].as_str().unwrap())
                .unwrap()
        };
        let size = message["size"].as_u64().unwrap() as usize;
        assert_eq!(
            keys.open(id, &field("enc"), &context, &field("ciphertext"), b"aad"),
            Ok(plaintext(size))
        );
    }
}

/// Messages sealed by the app with `@hpke/core` to the same key (written by the app's test).
#[test]
fn app_fixture_opens_here() {
    let fixture: Value = serde_json::from_str(
        &fs::read_to_string(APP_FIXTURE)
            .expect("run: WRITE_FIXTURE=1 pnpm exec vitest run src/protocol/hpke.test.ts"),
    )
    .unwrap();
    let (secret, _) = test_key(IKM);
    let keys = HpkeKeys::from_secrets(&[secret]).unwrap();
    let context = info(fixture["purpose"].as_str().unwrap(), &DEVNET_GENESIS_HASH);
    let messages = fixture["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 4);
    for message in messages {
        let field = |name: &str| {
            BASE64_STANDARD
                .decode(message[name].as_str().unwrap())
                .unwrap()
        };
        let size = message["size"].as_u64().unwrap() as usize;
        let key_id = message["keyId"].as_u64().unwrap() as u8;
        assert_eq!(
            keys.open(
                key_id,
                &field("enc"),
                &context,
                &field("ciphertext"),
                b"aad"
            ),
            Ok(plaintext(size)),
            "{size} bytes"
        );
    }
}

const NOT_BEFORE: u64 = 1_800_000_000;
const SLOT: u64 = 30 * 86_400;

fn opens_at(keys: &HpkeKeys, public: &<Kem as hpke::Kem>::PublicKey, id: u8, now: u64) -> bool {
    let context = info("relay", &DEVNET_GENESIS_HASH);
    let (encapsulated, ciphertext) = seal(public, &context, b"x", b"aad");
    keys.open_with_export_at(
        now,
        id,
        &encapsulated,
        &ciphertext,
        &context,
        b"aad",
        b"label",
    )
    .is_ok()
}

#[test]
fn a_key_opens_from_an_hour_before_its_slot_and_is_published_from_its_start() {
    let (secret, public) = test_key([3; 32]);
    let keys = HpkeKeys::from_schedule(&[(secret, NOT_BEFORE, NOT_BEFORE + SLOT)]).unwrap();
    let id = Sha256::digest(public.to_bytes())[0];
    assert!(!opens_at(&keys, &public, id, NOT_BEFORE - 3_601));
    assert!(opens_at(&keys, &public, id, NOT_BEFORE - 1_800));
    assert!(keys.published_at(NOT_BEFORE - 1_800).is_empty());
    let [published] = keys.published_at(NOT_BEFORE).try_into().unwrap();
    assert_eq!(
        (published.not_before, published.not_after),
        (NOT_BEFORE, NOT_BEFORE + SLOT)
    );
}

#[test]
fn a_retired_key_stays_published_an_hour_and_opens_until_the_longest_note_window() {
    let (secret, public) = test_key([4; 32]);
    let keys = HpkeKeys::from_schedule(&[(secret, NOT_BEFORE, NOT_BEFORE + SLOT)]).unwrap();
    let id = Sha256::digest(public.to_bytes())[0];
    let end = NOT_BEFORE + SLOT;
    assert_eq!(keys.published_at(end + 3_599).len(), 1);
    assert!(keys.published_at(end + 3_600).is_empty());
    assert!(opens_at(&keys, &public, id, end + 72 * 3_600 - 1));
    assert!(!opens_at(&keys, &public, id, end + 72 * 3_600));
}

#[test]
fn only_the_slots_that_have_begun_are_read_and_a_retired_file_is_deleted() {
    let dir = env::temp_dir().join(format!("buckspay-hpke-schedule-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let write = |name: &str, ikm: u8| {
        let path = dir.join(name);
        fs::write(&path, test_key([ikm; 32]).0).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path
    };
    let (past, current, absent) = (write("past", 5), write("current", 6), dir.join("later"));
    let slots = [
        (current.as_path(), NOT_BEFORE, NOT_BEFORE + SLOT),
        (past.as_path(), NOT_BEFORE - SLOT, NOT_BEFORE),
        (absent.as_path(), NOT_BEFORE + SLOT, NOT_BEFORE + 2 * SLOT),
    ];
    let keys = HpkeKeys::read_schedule(&slots, NOT_BEFORE + 10).unwrap();
    assert_eq!(keys.published_at(NOT_BEFORE + 10).len(), 2);
    assert_eq!(keys.sweep_retired(NOT_BEFORE + 72 * 3_600 - 1), 0);
    assert!(past.exists());
    assert_eq!(keys.sweep_retired(NOT_BEFORE + 72 * 3_600), 1);
    assert!(!past.exists() && current.exists());
    assert_eq!(keys.published_at(NOT_BEFORE + 10).len(), 1);
    fs::remove_dir_all(&dir).unwrap();
}
