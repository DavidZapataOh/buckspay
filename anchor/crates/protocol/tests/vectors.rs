#![cfg(feature = "verify")]

#[path = "../examples/vectors.rs"]
#[allow(dead_code)]
mod generator;

#[test]
fn committed_vectors_are_current() {
    let committed = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/vectors/v1.json"
    ))
    .unwrap();
    assert_eq!(
        committed,
        generator::render(),
        "run: cargo run -p buckspay-protocol --example vectors --features verify"
    );
}
