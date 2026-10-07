//! The host twin of the reward tree's hash, on the padded path the syscall runs on both clusters.
use solana_poseidon::{hashv, Endianness, Parameters};

pub fn hash(inputs: &[&[u8; 32]]) -> [u8; 32] {
    let inputs: Vec<&[u8]> = inputs.iter().map(|i| &i[..]).collect();
    hashv(Parameters::Bn254X5, Endianness::BigEndian, &inputs)
        .unwrap()
        .to_bytes()
}

/// `Poseidon(inner, exp)` with `exp` as a 32-byte big-endian integer.
pub fn poseidon2(inner: &[u8; 32], exp: u8) -> [u8; 32] {
    let mut exp32 = [0u8; 32];
    exp32[31] = exp;
    hash(&[inner, &exp32])
}
