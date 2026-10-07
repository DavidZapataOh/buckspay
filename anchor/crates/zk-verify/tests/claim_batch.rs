//! The generic batch verifier on the blind-claim key: its fixtures, and its refusal of every kind
//! of altered input.
use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use buckspay_zk_verify::{
    fr, verify_batch_with, verify_claims_raw_with, verify_claims_with, vk, ClaimPublic,
    VerifyError, CLAIM_PROOF_COMPRESSED, CLAIM_PROOF_RAW, PROOF_COMPRESSED,
};
use proptest::prelude::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixtures {
    vk_sha256: String,
    claims: Vec<Item>,
}

#[derive(Deserialize)]
struct Item {
    raw: String,
    compressed: String,
    public: Vec<String>,
}

struct Claim {
    raw: [u8; CLAIM_PROOF_RAW],
    compressed: [u8; CLAIM_PROOF_COMPRESSED],
    public: ClaimPublic,
}

fn claims() -> Vec<Claim> {
    let f: Fixtures = serde_json::from_str(include_str!("fixtures/claims.json")).unwrap();
    assert_eq!(f.vk_sha256, hex::encode(vk::CLAIM.sha256));
    f.claims
        .into_iter()
        .map(|c| Claim {
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
        .collect()
}

fn pick<T: Clone>(claims: &[Claim], mask: u8, f: impl Fn(&Claim) -> T) -> Vec<T> {
    claims
        .iter()
        .enumerate()
        .filter(|(i, _)| mask >> i & 1 == 1)
        .map(|(_, c)| f(c))
        .collect()
}

#[test]
fn every_subset_of_the_fixture_claims_verifies_on_both_layouts() {
    let claims = claims();
    for mask in 1u8..16 {
        let proofs = pick(&claims, mask, |c| c.compressed);
        let raws = pick(&claims, mask, |c| c.raw);
        let publics = pick(&claims, mask, |c| c.public);
        assert_eq!(verify_claims_with(&vk::CLAIM, &proofs, &publics), Ok(()));
        assert_eq!(verify_claims_raw_with(&vk::CLAIM, &raws, &publics), Ok(()));
    }
}

#[test]
fn proofs_and_publics_must_pair_up() {
    let claims = claims();
    let proofs = pick(&claims, 0b11, |c| c.compressed);
    let publics = pick(&claims, 0b01, |c| c.public);
    assert_eq!(
        verify_claims_with(&vk::CLAIM, &proofs, &publics),
        Err(VerifyError::Mismatch)
    );
    assert_eq!(
        verify_claims_with(&vk::CLAIM, &[], &[]),
        Err(VerifyError::Empty)
    );
    let swapped = [claims[1].public, claims[0].public];
    assert_eq!(
        verify_claims_with(&vk::CLAIM, &proofs, &swapped),
        Err(VerifyError::Pairing)
    );
}

#[test]
fn the_previous_claim_key_is_another_key() {
    let claims = claims();
    let previous = vk::CLAIM_PREVIOUS.expect("test keys");
    assert_ne!(previous.sha256, vk::CLAIM.sha256);
    assert!(verify_claims_with(&previous, &[claims[0].compressed], &[claims[0].public]).is_err());
}

#[test]
fn an_alias_of_a_public_input_is_refused_before_any_pairing() {
    let claims = claims();
    for slot in 0..7 {
        let mut public = claims[0].public;
        let mut alias = public[slot];
        let mut carry = 0u16;
        for (byte, modulus) in alias.iter_mut().zip(fr::MODULUS).rev() {
            let sum = u16::from(*byte) + u16::from(modulus) + carry;
            *byte = sum as u8;
            carry = sum >> 8;
        }
        if carry != 0 {
            continue;
        }
        public[slot] = alias;
        assert_eq!(
            verify_claims_with(&vk::CLAIM, &[claims[0].compressed], &[public]),
            Err(VerifyError::NonCanonical),
            "slot {slot}"
        );
    }
}

#[test]
fn a_key_that_does_not_fit_the_proofs_is_refused() {
    let claims = claims();
    let one = ([claims[0].compressed], [claims[0].public]);
    assert_eq!(
        verify_claims_with(&vk::VK, &one.0, &one.1),
        Err(VerifyError::KeyShape),
        "a key with a commitment, claim proofs without"
    );
    assert_eq!(
        verify_batch_with(&vk::CLAIM, &[[0u8; PROOF_COMPRESSED]], &[[[0u8; 32]; 10]]),
        Err(VerifyError::KeyShape),
        "a key without a commitment, chain proofs with one"
    );
    let short = vk::Vk {
        ic: &vk::CLAIM.ic[..7],
        ..vk::CLAIM
    };
    assert_eq!(
        verify_claims_with(&short, &one.0, &one.1),
        Err(VerifyError::KeyShape),
        "an input list longer than the key"
    );
    let long_ic: Vec<[u8; 64]> = vk::CLAIM
        .ic
        .iter()
        .chain(std::iter::once(&vk::CLAIM.ic[0]))
        .copied()
        .collect();
    let long = vk::Vk {
        ic: &long_ic,
        ..vk::CLAIM
    };
    assert_eq!(
        verify_claims_with(&long, &one.0, &one.1),
        Err(VerifyError::KeyShape),
        "a key with an input too many"
    );
    let none = vk::Vk {
        ic: &[],
        ..vk::CLAIM
    };
    assert_eq!(
        verify_claims_with(&none, &one.0, &one.1),
        Err(VerifyError::KeyShape)
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    #[test]
    fn no_flipped_bit_of_a_proof_or_a_public_input_verifies(
        mask in 1u8..16, which in 0usize..4, in_proof in any::<bool>(), at in 0usize..1024, bit in 0u8..8
    ) {
        let claims = claims();
        let mut proofs = pick(&claims, mask, |c| c.compressed);
        let mut publics = pick(&claims, mask, |c| c.public);
        let which = which % proofs.len();
        if in_proof {
            let at = at % CLAIM_PROOF_COMPRESSED;
            proofs[which][at] ^= 1 << bit;
        } else {
            let at = at % (7 * 32);
            publics[which][at / 32][at % 32] ^= 1 << bit;
        }
        prop_assert!(verify_claims_with(&vk::CLAIM, &proofs, &publics).is_err());
    }

    #[test]
    fn reduce_is_the_residue_below_the_modulus(x in any::<[u8; 32]>()) {
        let reduced = fr::reduce(&x);
        prop_assert!(fr::is_canonical(&reduced));
        let expected = Fr::from_be_bytes_mod_order(&x).into_bigint().to_bytes_be();
        prop_assert_eq!(&reduced[..], &expected[..]);
    }
}
