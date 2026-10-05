//! Where the record of a consumed output lives. The address is a program-derived address with a
//! fixed bump, so deriving it costs one `create_program_address` whatever the output id is, and an
//! output whose id does not give an off-curve address cannot be recorded at all: its signer grinds
//! the salt of the message until it can, and every receiver refuses an output that cannot.
pub const SPENT_SEED: &[u8] = b"spent";
/// The only bump a record address is derived with.
pub const RECORD_BUMP: u8 = 255;

/// The record address of `output` under `program`, or `None` when the output is not recordable
/// (the address is on the Ed25519 curve). The same computation as
/// `Pubkey::create_program_address(&[SPENT_SEED, output, &[RECORD_BUMP]], program)`.
#[cfg(feature = "verify")]
pub fn address(program: &[u8; 32], output: &[u8; 32]) -> Option<[u8; 32]> {
    let address = solana_sha256_hasher::hashv(&[
        SPENT_SEED,
        output,
        &[RECORD_BUMP],
        program,
        b"ProgramDerivedAddress",
    ])
    .to_bytes();
    let on_curve = curve25519_dalek::edwards::CompressedEdwardsY(address)
        .decompress()
        .is_some();
    (!on_curve).then_some(address)
}

#[cfg(all(test, feature = "verify"))]
mod tests {
    use super::*;

    const PROGRAM: [u8; 32] = [7; 32];

    #[test]
    fn about_half_of_the_ids_are_recordable() {
        let recordable = (0u32..4096)
            .filter(|n| {
                let mut id = [0u8; 32];
                id[..4].copy_from_slice(&n.to_le_bytes());
                address(&PROGRAM, &id).is_some()
            })
            .count();
        assert!(
            (1800..2300).contains(&recordable),
            "{recordable} of 4096 are recordable"
        );
    }

    #[test]
    fn the_address_depends_on_the_program_and_the_output() {
        let mut id = [0u8; 32];
        let (mut a, mut b) = (None, None);
        for n in 0u8..=255 {
            id[0] = n;
            a = a.or_else(|| address(&PROGRAM, &id));
            b = b.or_else(|| address(&[8; 32], &id));
        }
        assert!(a.is_some() && b.is_some());
        assert_ne!(a, b);
    }
}
