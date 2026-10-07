//! The verifying key the program trusts.

/// The commitment key of a Groth16 verifying key made with a BSB22 commitment.
#[derive(Clone, Copy)]
pub struct CommitmentKey<'a> {
    pub g: &'a [u8; 128],
    pub g_sigma_neg: &'a [u8; 128],
}

/// A Groth16 verifying key, points in the big-endian layout of the `alt_bn128` syscalls (G2 as
/// `x.c1, x.c0, y.c1, y.c0`). The verifier checks its shape against the proofs and public inputs it
/// is given, so one verifier serves keys of any number of public inputs, with or without a
/// commitment.
#[derive(Clone, Copy)]
pub struct Vk<'a> {
    /// SHA-256 of the key file the points come from.
    pub sha256: &'a [u8; 32],
    pub alpha_g1: &'a [u8; 64],
    pub beta_g2: &'a [u8; 128],
    pub gamma_g2: &'a [u8; 128],
    pub delta_g2: &'a [u8; 128],
    /// The constant one, the public inputs and, when the key has a commitment, its hash.
    pub ic: &'a [[u8; 64]],
    pub commitment: Option<CommitmentKey<'a>>,
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
    commitment: Some(CommitmentKey {
        g: &current::COMMITMENT_KEY_G,
        g_sigma_neg: &current::COMMITMENT_KEY_G_SIGMA_NEG,
    }),
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
    commitment: Some(CommitmentKey {
        g: &previous::COMMITMENT_KEY_G,
        g_sigma_neg: &previous::COMMITMENT_KEY_G_SIGMA_NEG,
    }),
});
#[cfg(not(feature = "test-keys"))]
pub const PREVIOUS: Option<Vk<'static>> = None;

#[cfg(feature = "test-keys")]
keys!(claim_current, "vk/claim_test.rs");
#[cfg(feature = "test-keys")]
keys!(claim_previous, "vk/claim_test_previous.rs");

/// Whether the claim keys come from a throwaway ceremony.
#[cfg(feature = "test-keys")]
pub const CLAIM_TEST_KEYS: bool = claim_current::TEST_KEYS;

/// The key blind claims are verified against.
#[cfg(feature = "test-keys")]
pub const CLAIM: Vk<'static> = Vk {
    sha256: &claim_current::VK_SHA256,
    alpha_g1: &claim_current::ALPHA_G1,
    beta_g2: &claim_current::BETA_G2,
    gamma_g2: &claim_current::GAMMA_G2,
    delta_g2: &claim_current::DELTA_G2,
    ic: &claim_current::IC,
    commitment: None,
};

/// The claim key before the last rotation, accepted for a while after it.
#[cfg(feature = "test-keys")]
pub const CLAIM_PREVIOUS: Option<Vk<'static>> = Some(Vk {
    sha256: &claim_previous::VK_SHA256,
    alpha_g1: &claim_previous::ALPHA_G1,
    beta_g2: &claim_previous::BETA_G2,
    gamma_g2: &claim_previous::GAMMA_G2,
    delta_g2: &claim_previous::DELTA_G2,
    ic: &claim_previous::IC,
    commitment: None,
});
#[cfg(not(feature = "test-keys"))]
pub const CLAIM_PREVIOUS: Option<Vk<'static>> = None;
