//! Writes the Ed25519 parity vectors: a key, a message and a signature each, built so that the
//! verifiers disagree where they can. Run: `cargo run -p buckspay-protocol --example ed25519_parity
//! --features verify > tests/vectors/ed25519_parity.json`.
use curve25519_dalek::{
    constants::{ED25519_BASEPOINT_POINT, EIGHT_TORSION},
    edwards::{CompressedEdwardsY, EdwardsPoint},
    scalar::Scalar,
};
use ed25519_dalek::{Signer as _, SigningKey, VerifyingKey};
use sha2::{Digest, Sha512};
use std::fmt::Write as _;

/// The order of the prime-order subgroup, little endian.
const L: [u8; 32] = [
    0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10,
];

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

fn challenge(r: &[u8; 32], a: &[u8; 32], message: &[u8]) -> Scalar {
    let mut hash = Sha512::new();
    hash.update(r);
    hash.update(a);
    hash.update(message);
    Scalar::from_hash(hash)
}

/// `s + L` as 32 bytes: the same scalar, not in canonical form.
fn add_l(s: &[u8; 32]) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    let mut carry = 0u16;
    for i in 0..32 {
        let sum = u16::from(s[i]) + u16::from(L[i]) + carry;
        out[i] = sum as u8;
        carry = sum >> 8;
    }
    (carry == 0).then_some(out)
}

struct Case {
    name: &'static str,
    key: [u8; 32],
    message: Vec<u8>,
    signature: [u8; 64],
}

fn main() {
    let secret = SigningKey::from_bytes(&[11; 32]);
    let key = secret.verifying_key().to_bytes();
    let message = b"BUCKSPAY ticket parity vector".to_vec();
    let good = secret.sign(&message).to_bytes();
    let mut cases = vec![Case {
        name: "valid",
        key,
        message: message.clone(),
        signature: good,
    }];

    let mut other = message.clone();
    other[3] ^= 1;
    cases.push(Case {
        name: "another_message",
        key,
        message: other,
        signature: good,
    });

    let mut bad_r = good;
    bad_r[5] ^= 1;
    cases.push(Case {
        name: "flipped_r",
        key,
        message: message.clone(),
        signature: bad_r,
    });
    let mut bad_s = good;
    bad_s[40] ^= 1;
    cases.push(Case {
        name: "flipped_s",
        key,
        message: message.clone(),
        signature: bad_s,
    });

    let s: [u8; 32] = good[32..].try_into().unwrap();
    if let Some(wrapped) = add_l(&s) {
        let mut sig = good;
        sig[32..].copy_from_slice(&wrapped);
        cases.push(Case {
            name: "s_plus_l",
            key,
            message: message.clone(),
            signature: sig,
        });
    }

    // Small-order keys with the classic forgery R = identity, S = 0.
    let mut identity = [0u8; 32];
    identity[0] = 1;
    let mut forged = [0u8; 64];
    forged[..32].copy_from_slice(&identity);
    for (name, torsion) in [
        ("small_order_key_identity", identity),
        (
            "small_order_key_order_2",
            EIGHT_TORSION[4].compress().to_bytes(),
        ),
        (
            "small_order_key_order_8",
            EIGHT_TORSION[1].compress().to_bytes(),
        ),
    ] {
        cases.push(Case {
            name,
            key: torsion,
            message: message.clone(),
            signature: forged,
        });
    }

    // y = p + 1 decodes to the identity: a key that is not the canonical encoding of any point.
    let mut non_canonical = [0xffu8; 32];
    non_canonical[0] = 0xee;
    non_canonical[31] = 0x7f;
    cases.push(Case {
        name: "non_canonical_key",
        key: non_canonical,
        message: message.clone(),
        signature: forged,
    });
    let mut nc_r = good;
    nc_r[..32].copy_from_slice(&non_canonical);
    cases.push(Case {
        name: "non_canonical_r",
        key,
        message: message.clone(),
        signature: nc_r,
    });

    // R with a torsion component: the cofactored equation holds, the strict one does not.
    let r_point = CompressedEdwardsY(good[..32].try_into().unwrap())
        .decompress()
        .unwrap();
    let mixed_r = (r_point + EIGHT_TORSION[1]).compress().to_bytes();
    let mut sig = good;
    sig[..32].copy_from_slice(&mixed_r);
    // The challenge changes with R, so the signature is rebuilt for it: S stays, the equation is
    // checked by every verifier from scratch.
    cases.push(Case {
        name: "r_with_torsion",
        key,
        message: message.clone(),
        signature: sig,
    });

    // A key with a torsion component, and a signature that verifies against it because the
    // challenge happens to be a multiple of 8 (found by grinding the message).
    let a_scalar = {
        let bytes = Sha512::digest([11u8; 32]);
        let mut clamped: [u8; 32] = bytes[..32].try_into().unwrap();
        clamped[0] &= 248;
        clamped[31] &= 63;
        clamped[31] |= 64;
        Scalar::from_bytes_mod_order(clamped)
    };
    let a_point: EdwardsPoint = a_scalar * ED25519_BASEPOINT_POINT;
    assert_eq!(a_point.compress().to_bytes(), key);
    let mixed_key = (a_point + EIGHT_TORSION[1]).compress().to_bytes();
    assert!(VerifyingKey::from_bytes(&mixed_key).is_ok());
    for counter in 0u32.. {
        let m = [b"mixed ".as_slice(), &counter.to_le_bytes()].concat();
        let r = Scalar::from_hash(Sha512::new_with_prefix([&m[..], b"nonce"].concat()));
        let big_r = (r * ED25519_BASEPOINT_POINT).compress().to_bytes();
        let k = challenge(&big_r, &mixed_key, &m);
        if k.to_bytes()[0] & 7 != 0 {
            continue;
        }
        let s = r + k * a_scalar;
        let mut sig = [0u8; 64];
        sig[..32].copy_from_slice(&big_r);
        sig[32..].copy_from_slice(&s.to_bytes());
        cases.push(Case {
            name: "mixed_order_key_challenge_multiple_of_8",
            key: mixed_key,
            message: m,
            signature: sig,
        });
        break;
    }

    let mut out = String::from("[\n");
    for (i, c) in cases.iter().enumerate() {
        let strict = VerifyingKey::from_bytes(&c.key).is_ok_and(|v| {
            v.verify_strict(
                &c.message,
                &ed25519_dalek::Signature::from_bytes(&c.signature),
            )
            .is_ok()
        });
        let _ = writeln!(
            out,
            "  {{ \"name\": \"{}\", \"key\": \"{}\", \"message\": \"{}\", \"signature\": \"{}\", \"verify_strict\": {} }}{}",
            c.name,
            hex(&c.key),
            hex(&c.message),
            hex(&c.signature),
            strict,
            if i + 1 == cases.len() { "" } else { "," }
        );
    }
    out.push_str("]\n");
    print!("{out}");
}
