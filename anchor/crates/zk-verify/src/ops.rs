//! The `alt_bn128` operations the batch equation needs: syscalls on the SBF target, the host
//! implementation elsewhere. Nothing here allocates on the SBF target, where the heap never
//! frees.

use crate::VerifyError;

pub type G1 = [u8; 64];
pub type G2 = [u8; 128];

const ADD: u64 = solana_bn254::prelude::ALT_BN128_G1_ADD_BE;
const MUL: u64 = solana_bn254::prelude::ALT_BN128_G1_MUL_BE;
const PAIRING: u64 = solana_bn254::prelude::ALT_BN128_PAIRING_BE;

#[cfg(target_os = "solana")]
fn group_op(op: u64, input: &[u8], out: &mut [u8]) -> Result<(), VerifyError> {
    // SAFETY: `input` and `out` are live slices at least as long as the syscall reads and writes.
    let status = unsafe {
        solana_define_syscall::definitions::sol_alt_bn128_group_op(
            op,
            input.as_ptr(),
            input.len() as u64,
            out.as_mut_ptr(),
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(VerifyError::BadPoint)
    }
}

#[cfg(not(target_os = "solana"))]
fn group_op(op: u64, input: &[u8], out: &mut [u8]) -> Result<(), VerifyError> {
    use solana_bn254::prelude::{
        alt_bn128_g1_addition_be, alt_bn128_g1_multiplication_be, alt_bn128_pairing_be,
    };
    let result = match op {
        ADD => alt_bn128_g1_addition_be(input),
        MUL => alt_bn128_g1_multiplication_be(input),
        _ => alt_bn128_pairing_be(input),
    }
    .map_err(|_| VerifyError::BadPoint)?;
    out.copy_from_slice(&result);
    Ok(())
}

pub fn g1_add(p: &G1, q: &G1) -> Result<G1, VerifyError> {
    let mut input = [0u8; 128];
    input[..64].copy_from_slice(p);
    input[64..].copy_from_slice(q);
    let mut out = [0u8; 64];
    group_op(ADD, &input, &mut out)?;
    Ok(out)
}

pub fn g1_mul(p: &G1, scalar: &[u8; 32]) -> Result<G1, VerifyError> {
    let mut input = [0u8; 96];
    input[..64].copy_from_slice(p);
    input[64..].copy_from_slice(scalar);
    let mut out = [0u8; 64];
    group_op(MUL, &input, &mut out)?;
    Ok(out)
}

/// Whether the product of the pairings of `input` (G1 ‖ G2 elements) is one.
pub fn pairing_is_one(input: &[u8]) -> Result<bool, VerifyError> {
    let mut out = [0u8; 32];
    group_op(PAIRING, input, &mut out)?;
    Ok(out[..31] == [0u8; 31] && out[31] == 1)
}

pub fn g1_decompress(point: &[u8; 32]) -> Result<G1, VerifyError> {
    solana_bn254::compression::prelude::alt_bn128_g1_decompress_be(point)
        .map_err(|_| VerifyError::BadPoint)
}

pub fn g2_decompress(point: &[u8; 64]) -> Result<G2, VerifyError> {
    solana_bn254::compression::prelude::alt_bn128_g2_decompress_be(point)
        .map_err(|_| VerifyError::BadPoint)
}

/// The base field modulus, big-endian.
const FQ: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];

/// The negation of a G1 point: `y` becomes `q - y`. The point at infinity stays.
pub fn g1_neg(p: &G1) -> G1 {
    let mut out = *p;
    if p[32..] == [0u8; 32] {
        return out;
    }
    let mut borrow = 0u16;
    for k in (0..32).rev() {
        let d = 256 + u16::from(FQ[k]) - u16::from(p[32 + k]) - borrow;
        out[32 + k] = d as u8;
        borrow = 1 - (d >> 8);
    }
    out
}
