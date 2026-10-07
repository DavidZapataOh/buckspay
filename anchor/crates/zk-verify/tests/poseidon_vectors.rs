//! The Go claim circuit's derivations against `solana_poseidon::hashv`, the padded path the
//! syscall runs, and the key the Go tooling exported.
use serde::Deserialize;
use solana_poseidon::{hashv, Endianness, Parameters};

fn hash(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    hashv(
        Parameters::Bn254X5,
        Endianness::BigEndian,
        &[&a[..], &b[..]],
    )
    .unwrap()
    .to_bytes()
}

fn word(s: &str) -> [u8; 32] {
    hex::decode(s).unwrap().try_into().unwrap()
}

fn exp(e: u8) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[31] = e;
    out
}

#[derive(Deserialize)]
struct Derivation {
    nullifier: String,
    trapdoor: String,
    exp: u8,
    scope: String,
    inner: String,
    leaf: String,
    nullifier_hash: String,
}

#[derive(Deserialize)]
struct Path {
    index: usize,
    siblings: Vec<String>,
}

#[derive(Deserialize)]
struct Vectors {
    depth: usize,
    zeros: Vec<String>,
    derivations: Vec<Derivation>,
    leaves: Vec<String>,
    root: String,
    paths: Vec<Path>,
}

fn vectors() -> Vectors {
    serde_json::from_str(include_str!(
        "../../../../prover/testdata/claim-vectors.json"
    ))
    .unwrap()
}

#[test]
fn go_leaf_and_nullifier_derivations_match_the_syscall_path() {
    let v = vectors();
    assert_eq!(v.derivations.len(), 9);
    for d in &v.derivations {
        let inner = hash(&word(&d.nullifier), &word(&d.trapdoor));
        assert_eq!(hex::encode(inner), d.inner);
        assert_eq!(hex::encode(hash(&inner, &exp(d.exp))), d.leaf);
        assert_eq!(
            hex::encode(hash(&word(&d.nullifier), &word(&d.scope))),
            d.nullifier_hash
        );
    }
}

#[test]
fn go_empty_nodes_root_and_paths_match_the_syscall_path() {
    let v = vectors();
    assert_eq!(v.depth, 20);
    assert_eq!(v.zeros[0], hex::encode([0u8; 32]));
    for k in 0..v.depth {
        let z = word(&v.zeros[k]);
        assert_eq!(hex::encode(hash(&z, &z)), v.zeros[k + 1]);
    }
    for (leaf, d) in v.leaves.iter().zip(&v.derivations) {
        assert_eq!(leaf, &d.leaf);
    }
    for p in &v.paths {
        let mut node = word(&v.leaves[p.index]);
        for (k, sibling) in p.siblings.iter().enumerate() {
            let sibling = word(sibling);
            node = if p.index >> k & 1 == 1 {
                hash(&sibling, &node)
            } else {
                hash(&node, &sibling)
            };
        }
        assert_eq!(hex::encode(node), v.root, "leaf {}", p.index);
    }
}

#[test]
fn the_exported_claim_key_has_eight_ic_points_and_is_marked_test_keys() {
    #[allow(dead_code)]
    mod claim_key {
        include!("../src/vk/claim_test.rs");
    }
    assert_eq!(claim_key::IC.len(), 8);
    assert_eq!(claim_key::NUM_PUBLIC, 7);
    const { assert!(claim_key::TEST_KEYS) };
}

#[test]
fn claim_fixtures_carry_the_seven_public_inputs_of_the_sample_tree() {
    #[derive(Deserialize)]
    struct Claim {
        raw: String,
        compressed: String,
        public: Vec<String>,
    }
    #[derive(Deserialize)]
    struct Fixtures {
        claims: Vec<Claim>,
    }
    let f: Fixtures = serde_json::from_str(include_str!("fixtures/claims.json")).unwrap();
    let root = vectors().root;
    assert_eq!(f.claims.len(), 4);
    for c in &f.claims {
        assert_eq!(hex::decode(&c.raw).unwrap().len(), 256);
        assert_eq!(hex::decode(&c.compressed).unwrap().len(), 128);
        assert_eq!(c.public.len(), 7);
        assert_eq!(c.public[0], root);
    }
}
