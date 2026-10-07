//! Sealing a settlement to the gateway the way a payer's app does, posting it the way a phone does
//! and reading the sealed answer.
#![allow(dead_code)]
use super::*;
use axum::{
    body::Body,
    extract::connect_info::MockConnectInfo,
    http::{Request, StatusCode, header},
};
use buckspay_gateway::{
    hpke::{HpkeKeys, info},
    relay::{EXPORT_LABEL, RELAY_AAD},
};
use chacha20poly1305::{
    ChaCha20Poly1305, Key, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use hkdf::Hkdf;
use hpke::{
    Deserializable, OpModeS, Serializable, aead::ChaCha20Poly1305 as HpkeChaCha, kdf::HkdfSha256,
    kem::X25519HkdfSha256,
};
use http_body_util::BodyExt;
use serde_json::Value;
use sha2_v11::Sha256;
use std::net::SocketAddr;
use tower::ServiceExt;

pub type Kem = X25519HkdfSha256;

/// The gateway's key as the app pins it.
pub fn gateway_key() -> (u8, <Kem as hpke::Kem>::PublicKey) {
    let published = hpke_keys().published().remove(0);
    let public = base64_decode(&published.public_key);
    (
        published.key_id,
        <Kem as hpke::Kem>::PublicKey::from_bytes(&public).unwrap(),
    )
}

pub fn hpke_keys() -> HpkeKeys {
    super::hpke()
}

pub fn base64_decode(value: &str) -> Vec<u8> {
    use base64::{Engine, prelude::BASE64_STANDARD};
    BASE64_STANDARD.decode(value).unwrap()
}

/// What the payer keeps to read the answer: the exporter secret and `enc`.
pub struct Opener {
    pub secret: [u8; 32],
    pub enc: [u8; 32],
}

impl Opener {
    /// The JSON the gateway sealed, or `None` when the body is not for this payer.
    pub fn open(&self, body: &[u8]) -> Option<Value> {
        let (nonce, ciphertext) = body.split_at_checked(32)?;
        let mut salt = [0u8; 64];
        salt[..32].copy_from_slice(&self.enc);
        salt[32..].copy_from_slice(nonce);
        let hkdf = Hkdf::<Sha256>::new(Some(&salt), &self.secret);
        let (mut key, mut iv) = ([0u8; 32], [0u8; 12]);
        hkdf.expand(b"key", &mut key).unwrap();
        hkdf.expand(b"nonce", &mut iv).unwrap();
        let plain = ChaCha20Poly1305::new(&Key::from(key))
            .decrypt(
                &Nonce::from(iv),
                Payload {
                    msg: ciphertext,
                    aad: b"",
                },
            )
            .ok()?;
        assert_eq!(plain.len(), 256, "every answer has the same length");
        let end = plain.iter().rposition(|byte| *byte != 0)? + 1;
        serde_json::from_slice(&plain[..end]).ok()
    }

    pub fn status(&self, body: &[u8]) -> String {
        self.open(body).expect("the answer opens")["status"]
            .as_str()
            .unwrap()
            .to_owned()
    }
}

/// The inner message of a relayed note: kind 2 when `word` (`commitment ‖ sig ‖ len ‖ proof`) is given.
pub fn inner(note: &Note, bucket: usize, word: Option<&[u8]>) -> Vec<u8> {
    let issue = hex::decode(note.issue_hex()).unwrap();
    let spends: Vec<Vec<u8>> = note
        .spend_hexes()
        .iter()
        .map(|spend| hex::decode(spend).unwrap())
        .collect();
    let mut plain = vec![1u8, if word.is_some() { 2 } else { 1 }];
    plain.extend((issue.len() as u16).to_be_bytes());
    plain.extend(&issue);
    plain.push(spends.len() as u8);
    for spend in &spends {
        plain.extend((spend.len() as u16).to_be_bytes());
        plain.extend(spend);
    }
    plain.extend(word.unwrap_or_default());
    plain.resize(bucket, 0);
    plain
}

pub fn seal_with(
    key_id: u8,
    public: &<Kem as hpke::Kem>::PublicKey,
    purpose: &str,
    genesis: [u8; 32],
    plain: &[u8],
) -> (Vec<u8>, Opener) {
    let (enc, mut context) = hpke::setup_sender::<HpkeChaCha, HkdfSha256, Kem>(
        &OpModeS::Base,
        public,
        &info(purpose, &genesis),
    )
    .unwrap();
    let ciphertext = context.seal(plain, RELAY_AAD).unwrap();
    let mut secret = [0u8; 32];
    context.export(EXPORT_LABEL, &mut secret).unwrap();
    let enc: [u8; 32] = enc.to_bytes().as_slice().try_into().unwrap();
    let mut blob = vec![key_id];
    blob.extend(enc);
    blob.extend(ciphertext);
    (blob, Opener { secret, enc })
}

pub async fn post_relay(sponsor: &Sponsor, peer: &str, body: Vec<u8>) -> (StatusCode, Vec<u8>) {
    let peer: SocketAddr = format!("{peer}:4000").parse().unwrap();
    let request = Request::post("/v1/relay")
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(Body::from(body))
        .unwrap();
    let response = sponsor
        .app
        .clone()
        .layer(MockConnectInfo(peer))
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status();
    (
        status,
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
}
