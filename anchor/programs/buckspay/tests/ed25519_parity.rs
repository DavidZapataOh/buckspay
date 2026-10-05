//! The Ed25519 precompile of the cluster's feature set accepts and rejects exactly what
//! `verify_strict` does on the parity vectors, including the small-order, non-canonical and
//! mixed-order cases that make registration check the key.
mod common;
use common::attesters::*;
use common::*;

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn the_precompile_agrees_with_verify_strict_on_every_parity_vector() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../crates/protocol/tests/vectors/ed25519_parity.json"
    ))
    .unwrap();
    let mut env = Env::new(TokenKind::Classic);
    let payer = env.payer.insecure_clone();
    for case in vectors.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let key: [u8; 32] = unhex(case["key"].as_str().unwrap()).try_into().unwrap();
        let signature: [u8; 64] = unhex(case["signature"].as_str().unwrap())
            .try_into()
            .unwrap();
        let message = unhex(case["message"].as_str().unwrap());
        let accepted = env
            .send(&payer, &[ed25519_ix(&key, &signature, &message)])
            .is_ok();
        eprintln!("precompile {name}: {accepted}");
        assert_eq!(accepted, case["verify_strict"].as_bool().unwrap(), "{name}");
    }
}
