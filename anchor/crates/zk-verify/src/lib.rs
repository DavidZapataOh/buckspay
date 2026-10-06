//! Batch verification of the per-message Groth16 proofs of a bearer note chain.
//!
//! The proofs are checked together by a random linear combination: with independent 128-bit
//! challenges `r_i` (`r_0 = 1`) and `rho`, the product of
//!
//! ```text
//! e(r_i A_i, B_i)                       for every proof
//! e(-sum(r_i) alpha, beta)
//! e(-sum(r_i L_i), gamma)               L_i = IC_0 + sum_j x_ij IC_(1+j) + h_i IC_11 + D_i
//! e(-sum(r_i C_i), delta)
//! e(rho sum(r_i D_i), g_sigma_neg)      the Pedersen proof of knowledge of the commitments
//! e(rho sum(r_i Pok_i), g)
//! ```
//!
//! must be one. `h_i` is the hash of `D_i` to the scalar field that gnark folds into the public
//! inputs. The sums over the public inputs run per column on an unreduced accumulator.

pub mod fr;
mod fr_hash;
mod ops;
mod public;
pub mod vk;

use solana_sha256_hasher::hashv;

pub use public::{consumed_outputs, public_inputs, ChainContext, MessagePublic};
use vk::Vk;

pub const NUM_PUBLIC: usize = 10;
/// `A 32 ‖ B 64 ‖ C 32 ‖ D 32 ‖ Pok 32`, each in the compressed big-endian form of the
/// `alt_bn128` compression syscalls.
pub const PROOF_COMPRESSED: usize = 192;
/// `A 64 ‖ B 128 ‖ C 64 ‖ D 64 ‖ Pok 64`, uncompressed big-endian.
pub const PROOF_RAW: usize = 384;
/// The deepest chain has `MAX_DEPTH` spends and its issue.
pub const MAX_PROOFS: usize = 17;
/// Public inputs of one proof, each a canonical big-endian field element.
pub type Public = [[u8; 32]; NUM_PUBLIC];

#[derive(Debug, PartialEq, Eq)]
pub enum VerifyError {
    Empty,
    TooMany,
    /// A public input is not below the field modulus.
    NonCanonical,
    /// A point is not on the curve or not in the right subgroup, or a syscall refused it.
    BadPoint,
    /// The pairing product is not one.
    Pairing,
    /// The proofs and the public inputs are not the same number.
    Mismatch,
    /// A wire field is out of range.
    Input,
}

const TRANSCRIPT_TAG: &[u8] = b"buckspay/zk-batch/v1";

/// The challenges of a batch under the compiled verifying key: `r_0 = 1`, then `r_i` per proof
/// and `rho`. They are for soundness only and seed nothing else.
pub fn challenges(proofs: &[u8], publics: &[Public]) -> ([u128; MAX_PROOFS], u128) {
    challenges_with(vk::VK.sha256, proofs, publics)
}

fn challenges_with(
    vk_sha256: &[u8; 32],
    proofs: &[u8],
    publics: &[Public],
) -> ([u128; MAX_PROOFS], u128) {
    let transcript = hashv(&[
        TRANSCRIPT_TAG,
        vk_sha256,
        &[publics.len() as u8],
        proofs,
        publics.as_flattened().as_flattened(),
    ])
    .to_bytes();
    let draw = |counter: &[u8]| {
        let h = hashv(&[&transcript, counter]).to_bytes();
        u128::from_le_bytes(h[..16].try_into().unwrap_or_default())
    };
    let mut r = [0u128; MAX_PROOFS];
    r[0] = 1;
    for (i, ri) in r.iter_mut().enumerate().take(publics.len()).skip(1) {
        *ri = draw(&(i as u32).to_le_bytes());
    }
    (r, draw(b"rho"))
}

/// The points of one proof, uncompressed.
struct Points {
    a: [u8; 64],
    b: [u8; 128],
    c: [u8; 64],
    d: [u8; 64],
    pok: [u8; 64],
}

trait Wire: Sized {
    fn points(&self) -> Result<Points, VerifyError>;
    fn flat(proofs: &[Self]) -> &[u8];
}

impl Wire for [u8; PROOF_COMPRESSED] {
    fn points(&self) -> Result<Points, VerifyError> {
        let g1 = |at: usize| {
            ops::g1_decompress(
                self[at..at + 32]
                    .try_into()
                    .map_err(|_| VerifyError::BadPoint)?,
            )
        };
        Ok(Points {
            a: g1(0)?,
            b: ops::g2_decompress(self[32..96].try_into().map_err(|_| VerifyError::BadPoint)?)?,
            c: g1(96)?,
            d: g1(128)?,
            pok: g1(160)?,
        })
    }

    fn flat(proofs: &[Self]) -> &[u8] {
        proofs.as_flattened()
    }
}

impl Wire for [u8; PROOF_RAW] {
    fn points(&self) -> Result<Points, VerifyError> {
        let split = |at: usize| -> Result<[u8; 64], VerifyError> {
            self[at..at + 64]
                .try_into()
                .map_err(|_| VerifyError::BadPoint)
        };
        Ok(Points {
            a: split(0)?,
            b: self[64..192]
                .try_into()
                .map_err(|_| VerifyError::BadPoint)?,
            c: split(192)?,
            d: split(256)?,
            pok: split(320)?,
        })
    }

    fn flat(proofs: &[Self]) -> &[u8] {
        proofs.as_flattened()
    }
}

fn scalar(r: u128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&r.to_be_bytes());
    out
}

fn verify<P: Wire>(vk: &Vk, proofs: &[P], publics: &[Public]) -> Result<(), VerifyError> {
    let n = proofs.len();
    if n == 0 {
        return Err(VerifyError::Empty);
    }
    if n > MAX_PROOFS {
        return Err(VerifyError::TooMany);
    }
    if publics.len() != n {
        return Err(VerifyError::Mismatch);
    }
    if !publics.as_flattened().iter().all(fr::is_canonical) {
        return Err(VerifyError::NonCanonical);
    }
    let (r, rho) = challenges_with(vk.sha256, P::flat(proofs), publics);

    let mut input = Vec::with_capacity((n + 5) * 192);
    let mut one = [0u8; 32];
    one[31] = 1;
    let mut sum_r = fr::Acc::default();
    let mut columns = [fr::Acc::default(); NUM_PUBLIC + 1];
    let (mut acc_c, mut acc_d, mut acc_pok) = ([0u8; 64], [0u8; 64], [0u8; 64]);
    for (i, ((proof, x), ri)) in proofs.iter().zip(publics).zip(r).enumerate() {
        let p = proof.points()?;
        sum_r.mul_add(ri, &one);
        for (column, xj) in columns.iter_mut().zip(x) {
            column.mul_add(ri, xj);
        }
        columns[NUM_PUBLIC].mul_add(ri, &fr_hash::commitment_to_field(&p.d));
        let (a, c, d, pok) = if i == 0 {
            (p.a, p.c, p.d, p.pok)
        } else {
            let k = scalar(ri);
            (
                ops::g1_mul(&p.a, &k)?,
                ops::g1_mul(&p.c, &k)?,
                ops::g1_mul(&p.d, &k)?,
                ops::g1_mul(&p.pok, &k)?,
            )
        };
        input.extend_from_slice(&a);
        input.extend_from_slice(&p.b);
        acc_c = ops::g1_add(&acc_c, &c)?;
        acc_d = ops::g1_add(&acc_d, &d)?;
        acc_pok = ops::g1_add(&acc_pok, &pok)?;
    }

    let sum_r = sum_r.reduce();
    let mut l = ops::g1_add(&ops::g1_mul(&vk.ic[0], &sum_r)?, &acc_d)?;
    for (ic, column) in vk.ic[1..].iter().zip(&columns) {
        if !column.is_zero() {
            l = ops::g1_add(&l, &ops::g1_mul(ic, &column.reduce())?)?;
        }
    }
    let rho = scalar(rho);
    input.extend_from_slice(&ops::g1_neg(&ops::g1_mul(vk.alpha_g1, &sum_r)?));
    input.extend_from_slice(vk.beta_g2);
    input.extend_from_slice(&ops::g1_neg(&l));
    input.extend_from_slice(vk.gamma_g2);
    input.extend_from_slice(&ops::g1_neg(&acc_c));
    input.extend_from_slice(vk.delta_g2);
    input.extend_from_slice(&ops::g1_mul(&acc_d, &rho)?);
    input.extend_from_slice(vk.commitment_g_sigma_neg);
    input.extend_from_slice(&ops::g1_mul(&acc_pok, &rho)?);
    input.extend_from_slice(vk.commitment_g);
    if ops::pairing_is_one(&input)? {
        Ok(())
    } else {
        Err(VerifyError::Pairing)
    }
}

/// Verifies compressed proofs under the compiled verifying key.
pub fn verify_batch(
    proofs: &[[u8; PROOF_COMPRESSED]],
    publics: &[Public],
) -> Result<(), VerifyError> {
    verify_batch_with(&vk::VK, proofs, publics)
}

/// Verifies uncompressed proofs under the compiled verifying key.
pub fn verify_batch_raw(proofs: &[[u8; PROOF_RAW]], publics: &[Public]) -> Result<(), VerifyError> {
    verify_batch_raw_with(&vk::VK, proofs, publics)
}

pub fn verify_batch_with(
    vk: &Vk,
    proofs: &[[u8; PROOF_COMPRESSED]],
    publics: &[Public],
) -> Result<(), VerifyError> {
    verify(vk, proofs, publics)
}

pub fn verify_batch_raw_with(
    vk: &Vk,
    proofs: &[[u8; PROOF_RAW]],
    publics: &[Public],
) -> Result<(), VerifyError> {
    verify(vk, proofs, publics)
}
