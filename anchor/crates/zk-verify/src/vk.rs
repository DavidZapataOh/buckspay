//! The verifying key the program trusts.

use crate::NUM_PUBLIC;

/// A Groth16 verifying key with one BSB22 commitment, points in the big-endian layout of the
/// `alt_bn128` syscalls (G2 as `x.c1, x.c0, y.c1, y.c0`).
#[derive(Clone, Copy)]
pub struct Vk<'a> {
    /// SHA-256 of the key file the points come from.
    pub sha256: &'a [u8; 32],
    pub alpha_g1: &'a [u8; 64],
    pub beta_g2: &'a [u8; 128],
    pub gamma_g2: &'a [u8; 128],
    pub delta_g2: &'a [u8; 128],
    /// The constant one, the public inputs and the commitment hash.
    pub ic: &'a [[u8; 64]; NUM_PUBLIC + 2],
    pub commitment_g: &'a [u8; 128],
    pub commitment_g_sigma_neg: &'a [u8; 128],
}

macro_rules! keys {
    ($name:ident, $file:literal) => {
        #[allow(dead_code)]
        mod $name {
            include!($file);
        }
    };
}

#[cfg(feature = "test-keys")]
keys!(current, "vk/test_current.rs");
#[cfg(not(feature = "test-keys"))]
compile_error!("no verifying key of a finished ceremony is pinned yet; build with `test-keys`");

pub use current::{TEST_KEYS, VK_SHA256};

/// The key proofs are verified against.
pub const VK: Vk<'static> = Vk {
    sha256: &current::VK_SHA256,
    alpha_g1: &current::ALPHA_G1,
    beta_g2: &current::BETA_G2,
    gamma_g2: &current::GAMMA_G2,
    delta_g2: &current::DELTA_G2,
    ic: &current::IC,
    commitment_g: &current::COMMITMENT_KEY_G,
    commitment_g_sigma_neg: &current::COMMITMENT_KEY_G_SIGMA_NEG,
};

#[cfg(feature = "test-keys")]
keys!(previous, "vk/test_previous.rs");

/// The key of the ceremony before the last rotation, accepted for a while after it.
#[cfg(feature = "test-keys")]
pub const PREVIOUS: Option<Vk<'static>> = Some(Vk {
    sha256: &previous::VK_SHA256,
    alpha_g1: &previous::ALPHA_G1,
    beta_g2: &previous::BETA_G2,
    gamma_g2: &previous::GAMMA_G2,
    delta_g2: &previous::DELTA_G2,
    ic: &previous::IC,
    commitment_g: &previous::COMMITMENT_KEY_G,
    commitment_g_sigma_neg: &previous::COMMITMENT_KEY_G_SIGMA_NEG,
});
#[cfg(not(feature = "test-keys"))]
pub const PREVIOUS: Option<Vk<'static>> = None;
