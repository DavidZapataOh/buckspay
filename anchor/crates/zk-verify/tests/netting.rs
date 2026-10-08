//! The netting key: Go's proofs verify, every altered public input and proof is refused, and a netting proof is
//! not accepted under another circuit's key.
use buckspay_zk_verify::{
    fr, verify_claims_raw_with, verify_netting_raw_with, verify_netting_with, vk, NettingPublic,
    VerifyError, CLAIM_NUM_PUBLIC, NETTING_NUM_PUBLIC, NETTING_PROOF_COMPRESSED, NETTING_PROOF_RAW,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixtures {
    vk_sha256: String,
    cases: Vec<Item>,
}

#[derive(Deserialize)]
struct Item {
    name: String,
    raw: String,
    compressed: String,
    public: Vec<String>,
}

struct Case {
    name: String,
    raw: [u8; NETTING_PROOF_RAW],
    compressed: [u8; NETTING_PROOF_COMPRESSED],
    public: NettingPublic,
}

fn cases() -> Vec<Case> {
    let f: Fixtures = serde_json::from_str(include_str!("fixtures/netting.json")).unwrap();
    assert_eq!(
        f.vk_sha256,
        hex::encode(vk::NETTING_VK.sha256),
        "fixtures of another key"
    );
    let cases: Vec<Case> = f
        .cases
        .into_iter()
        .map(|c| Case {
            name: c.name,
            raw: hex::decode(c.raw).unwrap().try_into().unwrap(),
            compressed: hex::decode(c.compressed).unwrap().try_into().unwrap(),
            public: c
                .public
                .iter()
                .map(|p| hex::decode(p).unwrap().try_into().unwrap())
                .collect::<Vec<[u8; 32]>>()
                .try_into()
                .unwrap(),
        })
        .collect();
    assert!(cases.len() >= 3, "the fixture set (Task 1 §1.4)");
    cases
}

#[test]
fn netting_vk_has_five_ic_points_no_commitment_and_is_marked_test_keys() {
    assert_eq!(vk::NETTING_VK.ic.len(), NETTING_NUM_PUBLIC + 1);
    assert!(vk::NETTING_VK.commitment.is_none());
    let test_keys = vk::NETTING_TEST_KEYS;
    assert!(test_keys);
    assert_ne!(vk::NETTING_VK.sha256, vk::CLAIM.sha256);
    assert_ne!(vk::NETTING_VK.sha256, vk::VK.sha256);
}

#[test]
fn rust_verifier_accepts_every_go_fixture_and_refuses_each_altered_public() {
    for c in cases() {
        verify_netting_raw_with(&vk::NETTING_VK, &[c.raw], &[c.public])
            .unwrap_or_else(|e| panic!("{}: {e:?}", c.name));
        verify_netting_with(&vk::NETTING_VK, &[c.compressed], &[c.public])
            .unwrap_or_else(|e| panic!("{}: {e:?}", c.name));
        for i in 0..NETTING_NUM_PUBLIC {
            let mut p = c.public;
            p[i][31] ^= 1;
            assert!(
                verify_netting_raw_with(&vk::NETTING_VK, &[c.raw], &[p]).is_err(),
                "{} public {i}",
                c.name
            );
        }
    }
}

#[test]
fn refuses_noncanonical_public_and_flipped_proof() {
    let c = &cases()[1];
    let mut p = c.public;
    p[3] = fr::MODULUS;
    assert_eq!(
        verify_netting_raw_with(&vk::NETTING_VK, &[c.raw], &[p]),
        Err(VerifyError::NonCanonical)
    );
    for at in [0usize, 63, 64, 191, 192, 255] {
        let mut proof = c.raw;
        proof[at] ^= 1;
        assert!(
            verify_netting_raw_with(&vk::NETTING_VK, &[proof], &[c.public]).is_err(),
            "byte {at}"
        );
    }
}

#[test]
fn a_netting_proof_is_refused_under_the_claim_key() {
    let c = &cases()[0];
    let mut widened = [[0u8; 32]; CLAIM_NUM_PUBLIC];
    widened[..NETTING_NUM_PUBLIC].copy_from_slice(&c.public);
    assert!(verify_claims_raw_with(&vk::CLAIM, &[c.raw], &[widened]).is_err());
}
