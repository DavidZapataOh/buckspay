//! Prints the Poseidon vectors the Go gadget is tested against, from the `solana_poseidon::hashv`
//! path that the syscall runs once `poseidon_enforce_padding` is active.
use serde::Serialize;
use solana_poseidon::{hashv, Endianness, Parameters};
use solana_sha256_hasher::hashv as sha256;

const R: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

#[derive(Serialize)]
struct Vector {
    inputs: Vec<String>,
    out: String,
    err: bool,
}

fn vector(a: &[u8; 32], b: &[u8; 32]) -> Vector {
    let hashed = hashv(
        Parameters::Bn254X5,
        Endianness::BigEndian,
        &[&a[..], &b[..]],
    );
    Vector {
        inputs: vec![hex::encode(a), hex::encode(b)],
        out: hashed
            .as_ref()
            .map(|h| hex::encode(h.to_bytes()))
            .unwrap_or_default(),
        err: hashed.is_err(),
    }
}

fn random(counter: u32) -> [u8; 32] {
    let mut out = sha256(&[b"buckspay/poseidon-vectors", &counter.to_be_bytes()]).to_bytes();
    out[0] &= 0x1f;
    out
}

fn main() {
    let word = |top: u8, last: u8| {
        let mut w = [0u8; 32];
        w[0] = top;
        w[31] = last;
        w
    };
    let mut r_minus_one = R;
    r_minus_one[31] -= 1;
    let mut r_plus_one = R;
    r_plus_one[31] += 1;
    let edge = [
        word(0, 0),
        word(0, 1),
        r_minus_one,
        word(0x20, 0),
        random(0),
    ];
    let mut vectors = Vec::new();
    for a in &edge {
        for b in &edge {
            vectors.push(vector(a, b));
        }
    }
    for i in 0..40 {
        vectors.push(vector(&random(1 + 2 * i), &random(2 + 2 * i)));
    }
    for refused in [R, r_plus_one, [0xff; 32]] {
        vectors.push(vector(&refused, &word(0, 1)));
        vectors.push(vector(&word(0, 1), &refused));
    }
    println!("{}", serde_json::to_string_pretty(&vectors).unwrap());
}
