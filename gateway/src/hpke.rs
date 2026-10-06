use crate::config::check_key_file;
use base64::{Engine, prelude::BASE64_STANDARD};
use hpke::{
    Deserializable, HpkeError, Kem as _, OpModeR, Serializable, aead::ChaCha20Poly1305,
    kdf::HkdfSha256, kem::X25519HkdfSha256,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::RwLock,
};

/// RFC 9180 identifiers of the one suite the gateway accepts.
pub const KEM_ID: u16 = 0x0020;
pub const KDF_ID: u16 = 0x0001;
pub const AEAD_ID: u16 = 0x0003;

type Kem = X25519HkdfSha256;

/// The HPKE `info` of a message for `purpose` on the cluster with `genesis_hash`: a sealed message
/// opens only for the purpose and cluster it was sealed for.
pub fn info(purpose: &str, genesis_hash: &[u8; 32]) -> Vec<u8> {
    let mut info = b"buckspay/hpke/v1\0".to_vec();
    info.extend_from_slice(purpose.as_bytes());
    info.push(0);
    info.extend_from_slice(genesis_hash);
    info
}

/// Seconds before its `not_before` a key already opens messages: a phone whose clock runs ahead of
/// the gateway's at a slot boundary may seal to the next key.
pub const OPEN_EARLY: u64 = 3_600;
/// Seconds after its `not_after` a key is still published: apps prefer the older slot that long.
pub const PUBLISH_LATE: u64 = 3_600;
/// Seconds after its `not_after` a key still opens messages, the longest a note can wait.
pub const RETIRED_GRACE: u64 = 72 * 3_600;
/// The slot of a key with no schedule: it never retires.
const ALWAYS: (u64, u64) = (0, u32::MAX as u64);

struct Key {
    id: u8,
    secret: <Kem as hpke::Kem>::PrivateKey,
    public: <Kem as hpke::Kem>::PublicKey,
    not_before: u64,
    not_after: u64,
    /// The file the secret was read from, deleted once the key retires.
    file: Option<PathBuf>,
}

impl Key {
    fn opens(&self, now: u64) -> bool {
        now.saturating_add(OPEN_EARLY) >= self.not_before
            && now < self.not_after.saturating_add(RETIRED_GRACE)
    }

    fn published(&self, now: u64) -> bool {
        now >= self.not_before && now < self.not_after.saturating_add(PUBLISH_LATE)
    }
}

/// The gateway's HPKE keys: the current one, which it publishes first, and the previous one while
/// apps that pinned only it are still in use.
pub struct HpkeKeys {
    keys: RwLock<Vec<Key>>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublishedKey {
    pub key_id: u8,
    pub kem_id: u16,
    pub kdf_id: u16,
    pub aead_id: u16,
    /// The X25519 public key, base64.
    pub public_key: String,
    /// The slot of the key, in seconds since the epoch: apps seal to the pinned key whose slot
    /// holds the time.
    pub not_before: u64,
    pub not_after: u64,
}

#[derive(Debug, PartialEq)]
pub enum OpenError {
    UnknownKey,
    Refused,
}

impl HpkeKeys {
    /// Keys from raw 32-byte X25519 secrets, current first. A key's id is the first byte of the
    /// SHA-256 of its public key; two keys with the same id are refused.
    pub fn from_secrets(secrets: &[[u8; 32]]) -> Result<Self, String> {
        let slots: Vec<_> = secrets
            .iter()
            .map(|secret| (*secret, ALWAYS.0, ALWAYS.1))
            .collect();
        Self::from_schedule(&slots)
    }

    /// Keys from raw secrets with the slot `(not_before, not_after)` each is valid for, current
    /// first.
    pub fn from_schedule(slots: &[([u8; 32], u64, u64)]) -> Result<Self, String> {
        let slots: Vec<_> = slots
            .iter()
            .map(|(secret, not_before, not_after)| (*secret, *not_before, *not_after, None))
            .collect();
        Self::build(&slots)
    }

    fn build(slots: &[([u8; 32], u64, u64, Option<PathBuf>)]) -> Result<Self, String> {
        let mut keys: Vec<Key> = Vec::new();
        for (secret, not_before, not_after, file) in slots {
            let secret = <Kem as hpke::Kem>::PrivateKey::from_bytes(secret)
                .map_err(|_| "not an X25519 secret key".to_owned())?;
            let public = Kem::sk_to_pk(&secret);
            let id = Sha256::digest(public.to_bytes())[0];
            if keys.iter().any(|key| key.id == id) {
                return Err(format!("two HPKE keys share the id {id}: generate another"));
            }
            keys.push(Key {
                id,
                secret,
                public,
                not_before: *not_before,
                not_after: *not_after,
                file: file.clone(),
            });
        }
        if keys.is_empty() {
            return Err("no HPKE key".into());
        }
        Ok(Self {
            keys: RwLock::new(keys),
        })
    }

    /// Reads raw 32-byte secrets from files only their owner can read, current first.
    pub fn read(paths: &[&Path]) -> Result<Self, String> {
        let mut secrets = Vec::new();
        for path in paths {
            let name = path.display();
            check_key_file(path)?;
            let bytes = fs::read(path).map_err(|error| format!("{name}: {error}"))?;
            secrets.push(
                <[u8; 32]>::try_from(bytes.as_slice())
                    .map_err(|_| format!("{name} is not a 32-byte X25519 secret key"))?,
            );
        }
        Self::from_secrets(&secrets)
    }

    /// Reads the secrets of a schedule `(path, not_before, not_after)` whose slot has begun by
    /// `now`, including the opening margin; the files of later slots are not read, and are
    /// absent from the gateway until their time. A slot past its retirement is not read either.
    pub fn read_schedule(slots: &[(&Path, u64, u64)], now: u64) -> Result<Self, String> {
        let mut secrets = Vec::new();
        for (path, not_before, not_after) in slots {
            if now.saturating_add(OPEN_EARLY) < *not_before
                || now >= not_after.saturating_add(RETIRED_GRACE)
            {
                continue;
            }
            let name = path.display();
            check_key_file(path)?;
            let bytes = fs::read(path).map_err(|error| format!("{name}: {error}"))?;
            let secret = <[u8; 32]>::try_from(bytes.as_slice())
                .map_err(|_| format!("{name} is not a 32-byte X25519 secret key"))?;
            secrets.push((secret, *not_before, *not_after, Some(path.to_path_buf())));
        }
        Self::build(&secrets)
    }

    /// What `/v1/hpke-config` publishes at `now`: the keys whose slot holds it, current first.
    pub fn published_at(&self, now: u64) -> Vec<PublishedKey> {
        self.keys
            .read()
            .unwrap()
            .iter()
            .filter(|key| key.published(now))
            .map(|key| PublishedKey {
                key_id: key.id,
                kem_id: KEM_ID,
                kdf_id: KDF_ID,
                aead_id: AEAD_ID,
                public_key: BASE64_STANDARD.encode(key.public.to_bytes()),
                not_before: key.not_before,
                not_after: key.not_after,
            })
            .collect()
    }

    pub fn published(&self) -> Vec<PublishedKey> {
        self.published_at(now())
    }

    /// Opens a message sealed to the key `key_id` with `info` and `aad`.
    pub fn open(
        &self,
        key_id: u8,
        encapsulated: &[u8],
        info: &[u8],
        ciphertext: &[u8],
        aad: &[u8],
    ) -> Result<Vec<u8>, OpenError> {
        self.open_with_export_at(now(), key_id, encapsulated, ciphertext, info, aad, b"")
            .map(|(plain, _)| plain)
    }

    /// Opens a message as `open` does at `now` and also exports 32 bytes of secret under
    /// `export_label` (RFC 9180 section 5.3), which only the sender and this key can derive.
    #[allow(clippy::too_many_arguments)]
    pub fn open_with_export_at(
        &self,
        now: u64,
        key_id: u8,
        encapsulated: &[u8],
        ciphertext: &[u8],
        info: &[u8],
        aad: &[u8],
        export_label: &[u8],
    ) -> Result<(Vec<u8>, [u8; 32]), OpenError> {
        let keys = self.keys.read().unwrap();
        let key = keys
            .iter()
            .find(|key| key.id == key_id && key.opens(now))
            .ok_or(OpenError::UnknownKey)?;
        let encapsulated = <Kem as hpke::Kem>::EncappedKey::from_bytes(encapsulated)
            .map_err(|_: HpkeError| OpenError::Refused)?;
        let mut context = hpke::setup_receiver::<ChaCha20Poly1305, HkdfSha256, Kem>(
            &OpModeR::Base,
            &key.secret,
            &encapsulated,
            info,
        )
        .map_err(|_| OpenError::Refused)?;
        let plain = context
            .open(ciphertext, aad)
            .map_err(|_| OpenError::Refused)?;
        let mut secret = [0u8; 32];
        context
            .export(export_label, &mut secret)
            .map_err(|_| OpenError::Refused)?;
        Ok((plain, secret))
    }

    /// Forgets the keys past their grace and deletes their secret files; returns how many.
    pub fn sweep_retired(&self, now: u64) -> usize {
        let mut keys = self.keys.write().unwrap();
        let before = keys.len();
        keys.retain(|key| {
            let live = now < key.not_after.saturating_add(RETIRED_GRACE);
            if !live && let Some(file) = &key.file {
                let _ = fs::remove_file(file);
            }
            live
        });
        before - keys.len()
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}
