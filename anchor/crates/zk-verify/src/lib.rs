//! Batch verification of Groth16 proofs of the BN254 circuits the program trusts: the per-message
//! proofs of a bearer note chain (ten public inputs and one BSB22 commitment) and the blind claims
//! (seven public inputs, no commitment).
//!
//! The proofs are checked together by a random linear combination: with independent 128-bit
//! challenges `r_i` (`r_0 = 1`) and `rho`, the product of
//!
//! ```text
//! e(r_i A_i, B_i)                       for every proof
//! e(-sum(r_i) alpha, beta)
//! e(-sum(r_i L_i), gamma)               L_i = IC_0 + sum_j x_ij IC_(1+j) [+ h_i IC_(1+n) + D_i]
//! e(-sum(r_i C_i), delta)
//! e(rho sum(r_i D_i), g_sigma_neg)      only with a commitment: the Pedersen proof of knowledge
//! e(rho sum(r_i Pok_i), g)              of the commitments
//! ```
//!
//! must be one. `h_i` is the hash of `D_i` to the scalar field that gnark folds into the public
//! inputs. The sums over the public inputs run per column on an unreduced accumulator. The key's
//! shape (public inputs, commitment or not) must match the proofs and public inputs it is given.

pub mod fr;
mod fr_hash;
mod ops;
mod public;
pub mod vk;

use solana_sha256_hasher::hashv;

pub use public::{consumed_outputs, public_inputs, ChainContext, MessagePublic};
use vk::Vk;

pub const NUM_PUBLIC: usize = 10;
/// Public inputs of a blind claim: root, nullifier hash, scope, recipient high and low limbs,
/// exponent and fee ceiling.
pub const CLAIM_NUM_PUBLIC: usize = 7;
/// `A 32 ‖ B 64 ‖ C 32`, compressed big-endian.
pub const CLAIM_PROOF_COMPRESSED: usize = 128;
/// `A 64 ‖ B 128 ‖ C 64`, uncompressed big-endian.
pub const CLAIM_PROOF_RAW: usize = 256;
/// `A 32 ‖ B 64 ‖ C 32 ‖ D 32 ‖ Pok 32`, each in the compressed big-endian form of the
/// `alt_bn128` compression syscalls.
pub const PROOF_COMPRESSED: usize = 192;
/// `A 64 ‖ B 128 ‖ C 64 ‖ D 64 ‖ Pok 64`, uncompressed big-endian.
pub const PROOF_RAW: usize = 384;
/// Public inputs of a netting: session field, participants, total and root.
pub const NETTING_NUM_PUBLIC: usize = 4;
/// `A 32 ‖ B 64 ‖ C 32`, compressed big-endian.
pub const NETTING_PROOF_COMPRESSED: usize = 128;
/// `A 64 ‖ B 128 ‖ C 64`, uncompressed big-endian.
pub const NETTING_PROOF_RAW: usize = 256;
/// The deepest chain has `MAX_DEPTH` spends and its issue.
pub const MAX_PROOFS: usize = 17;
/// Public inputs of one proof, each a canonical big-endian field element.
pub type Public = [[u8; 32]; NUM_PUBLIC];
/// Public inputs of one blind claim, each a canonical big-endian field element.
pub type ClaimPublic = [[u8; 32]; CLAIM_NUM_PUBLIC];
/// Public inputs of one netting, each a canonical big-endian field element.
pub type NettingPublic = [[u8; 32]; NETTING_NUM_PUBLIC];
/// The widest public input list of any key this verifier takes.
const MAX_PUBLIC: usize = NUM_PUBLIC;

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
    /// The key does not fit the proofs and public inputs: another number of public inputs, or a
    /// commitment where the proofs carry none or the other way round.
    KeyShape,
}

const TRANSCRIPT_TAG: &[u8] = b"buckspay/zk-batch/v1";

/// The challenges of a batch under the compiled verifying key: `r_0 = 1`, then `r_i` per proof
/// and `rho`. They are for soundness only and seed nothing else.
pub fn challenges(proofs: &[u8], publics: &[Public]) -> ([u128; MAX_PROOFS], u128) {
    challenges_with(vk::VK.sha256, proofs, publics)
}

fn challenges_with<X: AsRef<[[u8; 32]]>>(
    vk_sha256: &[u8; 32],
    proofs: &[u8],
    publics: &[X],
) -> ([u128; MAX_PROOFS], u128) {
    let count = [publics.len() as u8];
    let mut parts: [&[u8]; 4 + MAX_PROOFS] = [&[]; 4 + MAX_PROOFS];
    parts[..4].copy_from_slice(&[TRANSCRIPT_TAG, vk_sha256, &count, proofs]);
    for (part, x) in parts[4..].iter_mut().zip(publics) {
        *part = x.as_ref().as_flattened();
    }
    let transcript = hashv(&parts[..4 + publics.len().min(MAX_PROOFS)]).to_bytes();
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
    /// The commitment and its proof of knowledge, for proofs that carry one.
    commitment: Option<([u8; 64], [u8; 64])>,
}

trait Wire: Sized {
    /// Whether the proofs of this layout carry a commitment.
    const COMMITTED: bool;
    fn points(&self) -> Result<Points, VerifyError>;
    fn flat(proofs: &[Self]) -> &[u8];
}

fn g1_at(bytes: &[u8], at: usize) -> Result<[u8; 32], VerifyError> {
    bytes
        .get(at..at + 32)
        .and_then(|b| b.try_into().ok())
        .ok_or(VerifyError::BadPoint)
}

fn raw_at<const N: usize>(bytes: &[u8], at: usize) -> Result<[u8; N], VerifyError> {
    bytes
        .get(at..at + N)
        .and_then(|b| b.try_into().ok())
        .ok_or(VerifyError::BadPoint)
}

fn compressed_points(bytes: &[u8]) -> Result<Points, VerifyError> {
    let commitment = if bytes.len() == PROOF_COMPRESSED {
        Some((
            ops::g1_decompress(&g1_at(bytes, 128)?)?,
            ops::g1_decompress(&g1_at(bytes, 160)?)?,
        ))
    } else {
        None
    };
    Ok(Points {
        a: ops::g1_decompress(&g1_at(bytes, 0)?)?,
        b: ops::g2_decompress(&raw_at(bytes, 32)?)?,
        c: ops::g1_decompress(&g1_at(bytes, 96)?)?,
        commitment,
    })
}

fn raw_points(bytes: &[u8]) -> Result<Points, VerifyError> {
    let commitment = if bytes.len() == PROOF_RAW {
        Some((raw_at(bytes, 256)?, raw_at(bytes, 320)?))
    } else {
        None
    };
    Ok(Points {
        a: raw_at(bytes, 0)?,
        b: raw_at(bytes, 64)?,
        c: raw_at(bytes, 192)?,
        commitment,
    })
}

macro_rules! wire {
    ($len:expr, $committed:expr, $points:ident) => {
        impl Wire for [u8; $len] {
            const COMMITTED: bool = $committed;

            fn points(&self) -> Result<Points, VerifyError> {
                $points(self)
            }

            fn flat(proofs: &[Self]) -> &[u8] {
                proofs.as_flattened()
            }
        }
    };
}

wire!(PROOF_COMPRESSED, true, compressed_points);
wire!(PROOF_RAW, true, raw_points);
wire!(CLAIM_PROOF_COMPRESSED, false, compressed_points);
wire!(CLAIM_PROOF_RAW, false, raw_points);

fn scalar(r: u128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&r.to_be_bytes());
    out
}

fn verify<P: Wire, X: AsRef<[[u8; 32]]>>(
    vk: &Vk,
    proofs: &[P],
    publics: &[X],
) -> Result<(), VerifyError> {
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
    let committed = usize::from(P::COMMITTED);
    if vk.commitment.is_some() != P::COMMITTED {
        return Err(VerifyError::KeyShape);
    }
    let width = vk
        .ic
        .len()
        .checked_sub(1 + committed)
        .filter(|w| *w <= MAX_PUBLIC)
        .ok_or(VerifyError::KeyShape)?;
    if publics.iter().any(|x| x.as_ref().len() != width) {
        return Err(VerifyError::KeyShape);
    }
    if !publics
        .iter()
        .all(|x| x.as_ref().iter().all(fr::is_canonical))
    {
        return Err(VerifyError::NonCanonical);
    }
    let (r, rho) = challenges_with(vk.sha256, P::flat(proofs), publics);

    let mut input = Vec::with_capacity((n + 5) * 192);
    let mut one = [0u8; 32];
    one[31] = 1;
    let mut sum_r = fr::Acc::default();
    let mut columns = [fr::Acc::default(); MAX_PUBLIC + 1];
    let columns = &mut columns[..width + committed];
    let (mut acc_c, mut acc_d, mut acc_pok) = ([0u8; 64], [0u8; 64], [0u8; 64]);
    for (i, ((proof, x), ri)) in proofs.iter().zip(publics).zip(r).enumerate() {
        let p = proof.points()?;
        sum_r.mul_add(ri, &one);
        for (column, xj) in columns.iter_mut().zip(x.as_ref()) {
            column.mul_add(ri, xj);
        }
        let k = scalar(ri);
        let scaled = |point: &[u8; 64]| {
            if i == 0 {
                Ok(*point)
            } else {
                ops::g1_mul(point, &k)
            }
        };
        input.extend_from_slice(&scaled(&p.a)?);
        input.extend_from_slice(&p.b);
        acc_c = ops::g1_add(&acc_c, &scaled(&p.c)?)?;
        if let Some((d, pok)) = &p.commitment {
            columns[width].mul_add(ri, &fr_hash::commitment_to_field(d));
            acc_d = ops::g1_add(&acc_d, &scaled(d)?)?;
            acc_pok = ops::g1_add(&acc_pok, &scaled(pok)?)?;
        }
    }

    let sum_r = sum_r.reduce();
    let mut l = ops::g1_mul(&vk.ic[0], &sum_r)?;
    if vk.commitment.is_some() {
        l = ops::g1_add(&l, &acc_d)?;
    }
    for (ic, column) in vk.ic[1..].iter().zip(columns.iter()) {
        if !column.is_zero() {
            l = ops::g1_add(&l, &ops::g1_mul(ic, &column.reduce())?)?;
        }
    }
    input.extend_from_slice(&ops::g1_neg(&ops::g1_mul(vk.alpha_g1, &sum_r)?));
    input.extend_from_slice(vk.beta_g2);
    input.extend_from_slice(&ops::g1_neg(&l));
    input.extend_from_slice(vk.gamma_g2);
    input.extend_from_slice(&ops::g1_neg(&acc_c));
    input.extend_from_slice(vk.delta_g2);
    if let Some(key) = &vk.commitment {
        let rho = scalar(rho);
        input.extend_from_slice(&ops::g1_mul(&acc_d, &rho)?);
        input.extend_from_slice(key.g_sigma_neg);
        input.extend_from_slice(&ops::g1_mul(&acc_pok, &rho)?);
        input.extend_from_slice(key.g);
    }
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

/// Verifies compressed blind-claim proofs under `vk`.
pub fn verify_claims_with(
    vk: &Vk,
    proofs: &[[u8; CLAIM_PROOF_COMPRESSED]],
    publics: &[ClaimPublic],
) -> Result<(), VerifyError> {
    verify(vk, proofs, publics)
}

/// Verifies uncompressed blind-claim proofs under `vk`.
pub fn verify_claims_raw_with(
    vk: &Vk,
    proofs: &[[u8; CLAIM_PROOF_RAW]],
    publics: &[ClaimPublic],
) -> Result<(), VerifyError> {
    verify(vk, proofs, publics)
}

/// Verifies compressed netting proofs under `vk`.
pub fn verify_netting_with(
    vk: &Vk,
    proofs: &[[u8; NETTING_PROOF_COMPRESSED]],
    publics: &[NettingPublic],
) -> Result<(), VerifyError> {
    verify(vk, proofs, publics)
}

/// Verifies uncompressed netting proofs under `vk`.
pub fn verify_netting_raw_with(
    vk: &Vk,
    proofs: &[[u8; NETTING_PROOF_RAW]],
    publics: &[NettingPublic],
) -> Result<(), VerifyError> {
    verify(vk, proofs, publics)
}
