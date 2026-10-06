//! The hash of a BSB22 commitment to the scalar field, in the form the circuit is proved with:
//! the SHA-256 of the 64 uncompressed bytes of the commitment, read as a big-endian integer
//! modulo `r`.

use solana_sha256_hasher::hash;

use crate::fr::Acc;

pub fn commitment_to_field(commitment: &[u8; 64]) -> [u8; 32] {
    let mut acc = Acc::default();
    acc.mul_add(1, &hash(commitment).to_bytes());
    acc.reduce()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_bn254::Fr;
    use ark_ff::{BigInteger, PrimeField};
    use solana_sha256_hasher::hash;

    #[test]
    fn reduces_the_digest_modulo_r() {
        for seed in 0u8..64 {
            let point: [u8; 64] =
                core::array::from_fn(|i| seed.wrapping_mul(31).wrapping_add(i as u8));
            let want = Fr::from_be_bytes_mod_order(&hash(&point).to_bytes());
            assert_eq!(
                commitment_to_field(&point).to_vec(),
                want.into_bigint().to_bytes_be(),
                "seed {seed}"
            );
        }
    }
}
