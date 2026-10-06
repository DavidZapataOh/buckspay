use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use buckspay_zk_verify::fr::Acc;
use proptest::prelude::*;

fn fr_be(x: &Fr) -> [u8; 32] {
    x.into_bigint().to_bytes_be().try_into().unwrap()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(20_000))]
    #[test]
    fn accumulation_matches_arkworks(
        xs in prop::collection::vec(any::<[u8; 32]>(), 1..=17),
        rs in prop::collection::vec(any::<u128>(), 17),
    ) {
        let mut acc = Acc::default();
        let mut want = Fr::from(0u64);
        for (k, x) in xs.iter().enumerate() {
            let x = Fr::from_be_bytes_mod_order(x);
            acc.mul_add(rs[k], &fr_be(&x));
            want += Fr::from(rs[k]) * x;
        }
        prop_assert_eq!(acc.reduce(), fr_be(&want));
    }

    #[test]
    fn a_non_canonical_operand_reduces_like_its_residue(
        r in any::<u128>(),
        x in any::<[u8; 32]>(),
    ) {
        let mut acc = Acc::default();
        acc.mul_add(r, &x);
        let want = Fr::from(r) * Fr::from_be_bytes_mod_order(&x);
        prop_assert_eq!(acc.reduce(), fr_be(&want));
    }

    #[test]
    fn canonical_means_below_the_modulus(x in any::<[u8; 32]>()) {
        let below = Fr::from_be_bytes_mod_order(&x).into_bigint().to_bytes_be() == x.to_vec();
        prop_assert_eq!(buckspay_zk_verify::fr::is_canonical(&x), below);
    }
}

#[test]
fn worst_case_does_not_overflow() {
    let max = fr_be(&(-Fr::from(1u64)));
    let mut acc = Acc::default();
    for _ in 0..17 {
        acc.mul_add(u128::MAX, &max);
    }
    let want = (0..17).fold(Fr::from(0u64), |s, _| {
        s + Fr::from(u128::MAX) * (-Fr::from(1u64))
    });
    assert_eq!(acc.reduce(), fr_be(&want));
}

#[test]
fn the_modulus_itself_is_not_canonical() {
    assert!(!buckspay_zk_verify::fr::is_canonical(
        &buckspay_zk_verify::fr::MODULUS
    ));
}

proptest! {
    #[test]
    fn multiples_of_the_modulus_reduce_to_zero(r in any::<u128>(), extra in 0u128..3) {
        let mut acc = Acc::default();
        acc.mul_add(r, &buckspay_zk_verify::fr::MODULUS);
        prop_assert_eq!(acc.reduce(), [0u8; 32]);
        let mut one_over = acc;
        one_over.mul_add(extra, &{ let mut one = [0u8; 32]; one[31] = 1; one });
        let want = Fr::from(extra);
        prop_assert_eq!(one_over.reduce(), fr_be(&want));
    }
}
