use buckspay_zk_verify::{verify_batch_raw_with, verify_batch_with, VerifyError, PROOF_COMPRESSED};

mod common;
use common::{fixture, groth16_solana_accepts, test_vk};

#[test]
fn accepts_every_batch_size_from_one_to_seventeen() {
    let f = fixture("chain16.json");
    let vk = test_vk();
    for n in 1..=17 {
        assert_eq!(
            verify_batch_with(&vk, &f.compressed[..n], &f.publics[..n]),
            Ok(()),
            "n={n}"
        );
        assert_eq!(
            verify_batch_raw_with(&vk, &f.raw[..n], &f.publics[..n]),
            Ok(()),
            "raw n={n}"
        );
    }
}

// groth16-solana hashes the commitment with the default form of gnark (expand_message_xmd), the
// circuit is proved with the SHA-256 form, so it refuses every proof of the chain; the proof made
// with the default form is the one it accepts and the one this verifier refuses.
#[test]
fn groth16_solana_accepts_only_the_other_hash_to_field_form() {
    let f = fixture("chain16.json");
    let vk = test_vk();
    for i in 0..17 {
        assert!(!groth16_solana_accepts(&f, i), "proof {i}");
        assert!(verify_batch_with(&vk, &f.compressed[i..=i], &f.publics[i..=i]).is_ok());
    }
    let default_form = common::negatives()
        .into_iter()
        .find(|c| c.name == "default_hash_to_field")
        .unwrap();
    assert!(common::groth16_solana_accepts_raw(&vk, &default_form));
    assert!(verify_batch_raw_with(&vk, &[default_form.raw], &[default_form.public]).is_err());
}

#[test]
fn rejects_any_single_change() {
    let f = fixture("chain16.json");
    let vk = test_vk();
    for i in 0..17 {
        for j in 0..10 {
            let mut p = f.publics.clone();
            p[i][j][31] ^= 1;
            if !buckspay_zk_verify::fr::is_canonical(&p[i][j]) {
                continue;
            }
            assert!(
                verify_batch_with(&vk, &f.compressed, &p).is_err(),
                "public {i}.{j}"
            );
        }
        for byte in [0usize, 40, 100, 140, 170] {
            let mut c = f.compressed.clone();
            c[i][byte] ^= 1;
            assert!(
                verify_batch_with(&vk, &c, &f.publics).is_err(),
                "proof {i} byte {byte}"
            );
        }
    }
}

#[test]
fn rejects_swapped_proofs() {
    let f = fixture("chain16.json");
    let mut c = f.compressed.clone();
    c.swap(3, 4);
    assert!(verify_batch_with(&test_vk(), &c, &f.publics).is_err());
}

#[test]
fn rejects_non_canonical_public_input() {
    let f = fixture("chain16.json");
    let mut p = f.publics.clone();
    p[0][4] = common::R_BYTES;
    assert_eq!(
        verify_batch_with(&test_vk(), &f.compressed, &p),
        Err(VerifyError::NonCanonical)
    );
}

#[test]
fn rejects_empty_and_oversized_batches() {
    let vk = test_vk();
    assert_eq!(verify_batch_with(&vk, &[], &[]), Err(VerifyError::Empty));
    let f = fixture("chain16.json");
    let mut c = f.compressed.clone();
    let mut p = f.publics.clone();
    c.push([0u8; PROOF_COMPRESSED]);
    p.push(p[0]);
    assert_eq!(verify_batch_with(&vk, &c, &p), Err(VerifyError::TooMany));
}

#[test]
fn rejects_proofs_and_publics_of_different_counts() {
    let f = fixture("chain16.json");
    assert_eq!(
        verify_batch_with(&test_vk(), &f.compressed[..3], &f.publics[..2]),
        Err(VerifyError::Mismatch)
    );
}

#[test]
fn challenges_depend_on_every_byte_and_start_at_one() {
    let f = fixture("chain16.json");
    let flat: Vec<u8> = f.compressed.iter().flatten().copied().collect();
    let (r, rho) = buckspay_zk_verify::challenges(&flat, &f.publics);
    assert_eq!(r[0], 1);
    let mut p = f.publics.clone();
    p[16][9][31] ^= 1;
    let (r2, rho2) = buckspay_zk_verify::challenges(&flat, &p);
    assert_ne!((r[1], rho), (r2[1], rho2));
    let mut altered = flat.clone();
    altered[16 * PROOF_COMPRESSED + 191] ^= 1;
    let (r3, rho3) = buckspay_zk_verify::challenges(&altered, &f.publics);
    assert_ne!((r[1], rho), (r3[1], rho3));
}

#[test]
fn compressed_points_decompress_to_the_raw_proofs() {
    let f = fixture("chain16.json");
    let vk = test_vk();
    for i in 0..17 {
        assert_eq!(
            verify_batch_raw_with(&vk, &f.raw[i..=i], &f.publics[i..=i]),
            verify_batch_with(&vk, &f.compressed[i..=i], &f.publics[i..=i]),
            "proof {i}"
        );
    }
}

#[test]
fn compiled_vk_matches_the_manifest_and_verifies_the_fixtures() {
    let manifest: serde_json::Value =
        serde_json::from_str(include_str!("../../../../deploy/zk/manifest.test.json")).unwrap();
    assert_eq!(
        hex::encode(buckspay_zk_verify::vk::VK_SHA256),
        manifest["VKSHA256"].as_str().unwrap()
    );
    assert_eq!(manifest["Test"], true);
    const { assert!(buckspay_zk_verify::vk::TEST_KEYS) };
    let f = fixture("chain16.json");
    assert_eq!(
        buckspay_zk_verify::verify_batch(&f.compressed[..3], &f.publics[..3]),
        Ok(())
    );
}

#[test]
fn gnark_agrees_on_every_fixture() {
    let f = fixture("chain16.json");
    let vk = test_vk();
    for i in 0..17 {
        assert!(f.gnark_accepts[i], "gnark rejects positive proof {i}");
        assert_eq!(
            verify_batch_raw_with(&vk, &f.raw[i..=i], &f.publics[i..=i]),
            Ok(()),
            "proof {i}"
        );
    }
    for case in common::negatives() {
        assert!(
            !case.gnark_accepts,
            "{}: gnark accepts a negative fixture",
            case.name
        );
        assert!(
            verify_batch_raw_with(&vk, &[case.raw], &[case.public]).is_err(),
            "{} accepted by ours",
            case.name
        );
        if case.name != "default_hash_to_field" {
            assert!(
                !common::groth16_solana_accepts_raw(&vk, &case),
                "{} accepted by groth16-solana",
                case.name
            );
        }
    }
}

#[test]
fn off_subgroup_g2_point_is_rejected() {
    let f = fixture("chain16.json");
    let vk = test_vk();
    let b = common::g2_on_curve_off_subgroup();
    let mut raw = f.raw[0];
    raw[64..192].copy_from_slice(&b.raw_be());
    assert!(verify_batch_raw_with(&vk, &[raw], &f.publics[..1]).is_err());
    let mut comp = f.compressed[0];
    comp[32..96].copy_from_slice(&b.compressed_be());
    assert!(verify_batch_with(&vk, &[comp], &f.publics[..1]).is_err());
}

#[test]
fn vk_has_twelve_ic_points() {
    assert_eq!(
        buckspay_zk_verify::vk::VK.ic.len(),
        buckspay_zk_verify::NUM_PUBLIC + 2
    );
    assert_eq!(test_vk().ic.len(), 12);
}
