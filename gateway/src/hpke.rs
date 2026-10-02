use base64::{Engine, prelude::BASE64_STANDARD};
use hpke::{
    Deserializable, HpkeError, Kem as _, OpModeR, Serializable, aead::ChaCha20Poly1305,
    kdf::HkdfSha256, kem::X25519HkdfSha256,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, os::unix::fs::PermissionsExt, path::Path};

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

struct Key {
    id: u8,
    secret: <Kem as hpke::Kem>::PrivateKey,
    public: <Kem as hpke::Kem>::PublicKey,
}

/// The gateway's HPKE keys: the current one, which it publishes first, and the previous one while
/// apps that pinned only it are still in use.
pub struct HpkeKeys {
    keys: Vec<Key>,
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
        let mut keys: Vec<Key> = Vec::new();
        for secret in secrets {
            let secret = <Kem as hpke::Kem>::PrivateKey::from_bytes(secret)
                .map_err(|_| "not an X25519 secret key".to_owned())?;
            let public = Kem::sk_to_pk(&secret);
            let id = Sha256::digest(public.to_bytes())[0];
            if keys.iter().any(|key| key.id == id) {
                return Err(format!("two HPKE keys share the id {id}: generate another"));
            }
            keys.push(Key { id, secret, public });
        }
        if keys.is_empty() {
            return Err("no HPKE key".into());
        }
        Ok(Self { keys })
    }

    /// Reads raw 32-byte secrets from files only their owner can read, current first.
    pub fn read(paths: &[&Path]) -> Result<Self, String> {
        let mut secrets = Vec::new();
        for path in paths {
            let name = path.display();
            let metadata = fs::metadata(path).map_err(|error| format!("{name}: {error}"))?;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(format!(
                    "{name} must not be readable by other users (chmod 600)"
                ));
            }
            let bytes = fs::read(path).map_err(|error| format!("{name}: {error}"))?;
            secrets.push(
                <[u8; 32]>::try_from(bytes.as_slice())
                    .map_err(|_| format!("{name} is not a 32-byte X25519 secret key"))?,
            );
        }
        Self::from_secrets(&secrets)
    }

    /// What `/v1/hpke-config` publishes: every key, current first.
    pub fn published(&self) -> Vec<PublishedKey> {
        self.keys
            .iter()
            .map(|key| PublishedKey {
                key_id: key.id,
                kem_id: KEM_ID,
                kdf_id: KDF_ID,
                aead_id: AEAD_ID,
                public_key: BASE64_STANDARD.encode(key.public.to_bytes()),
            })
            .collect()
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
        let key = self
            .keys
            .iter()
            .find(|key| key.id == key_id)
            .ok_or(OpenError::UnknownKey)?;
        let encapsulated = <Kem as hpke::Kem>::EncappedKey::from_bytes(encapsulated)
            .map_err(|_: HpkeError| OpenError::Refused)?;
        hpke::single_shot_open::<ChaCha20Poly1305, HkdfSha256, Kem>(
            &OpModeR::Base,
            &key.secret,
            &encapsulated,
            info,
            ciphertext,
            aad,
        )
        .map_err(|_| OpenError::Refused)
    }
}
