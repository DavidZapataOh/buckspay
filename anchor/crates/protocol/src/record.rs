//! Where the record of a consumed output and the claim against an output live. Both addresses are
//! program-derived addresses with a fixed bump, so deriving one costs a single
//! `create_program_address` whatever the output id is, and an output whose id does not give an
//! off-curve address cannot be recorded or claimed at all: its signer grinds the salt of the
//! message until it can, and every receiver refuses an output that cannot.
pub const SPENT_SEED: &[u8] = b"spent";
pub const CLAIM_SEED: &[u8] = b"claim";
/// The only bump a record or claim address is derived with.
pub const RECORD_BUMP: u8 = 255;

/// How many messages of a chain its records vouch for. Each item is the index of the message that
/// consumed an output (when a record of that output can vouch for a message at all) and whether the
/// record exists with that message's content. A record is written only after the message, the one
/// that created the output and everything before them were verified, and the output id commits to
/// all of them: the result is the highest matching message plus one, gaps allowed, or 0.
pub fn vouched_prefix(items: impl IntoIterator<Item = (Option<usize>, bool)>) -> usize {
    items
        .into_iter()
        .filter_map(|(message, matches)| message.filter(|_| matches).map(|message| message + 1))
        .max()
        .unwrap_or(0)
}

#[cfg(feature = "verify")]
fn derive(seed: &[u8], program: &[u8; 32], output: &[u8; 32]) -> Option<[u8; 32]> {
    let address = solana_sha256_hasher::hashv(&[
        seed,
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

/// The record address of `output` under `program`, or `None` when the output is not recordable
/// (the address is on the Ed25519 curve). The same computation as
/// `Pubkey::create_program_address(&[SPENT_SEED, output, &[RECORD_BUMP]], program)`.
#[cfg(feature = "verify")]
pub fn address(program: &[u8; 32], output: &[u8; 32]) -> Option<[u8; 32]> {
    derive(SPENT_SEED, program, output)
}

/// The claim address of `output`, or `None` when the output cannot be claimed.
#[cfg(feature = "verify")]
pub fn claim_address(program: &[u8; 32], output: &[u8; 32]) -> Option<[u8; 32]> {
    derive(CLAIM_SEED, program, output)
}

/// Whether an output can be accepted from a payer: it has a record address, for the settlement of
/// the chain it is in, and a claim address, for the burn if the chain turns out to be a fraud.
#[cfg(feature = "verify")]
pub fn recordable(program: &[u8; 32], output: &[u8; 32]) -> bool {
    address(program, output).is_some() && claim_address(program, output).is_some()
}

#[cfg(all(test, feature = "verify"))]
mod tests {
    use super::*;

    const PROGRAM: [u8; 32] = [7; 32];

    fn id(n: u32) -> [u8; 32] {
        let mut id = [0u8; 32];
        id[..4].copy_from_slice(&n.to_le_bytes());
        id
    }

    #[test]
    fn about_half_of_the_ids_have_each_address_and_a_quarter_have_both() {
        let ids = || (0u32..4096).map(id);
        let spent = ids().filter(|i| address(&PROGRAM, i).is_some()).count();
        let claim = ids()
            .filter(|i| claim_address(&PROGRAM, i).is_some())
            .count();
        let both = ids().filter(|i| recordable(&PROGRAM, i)).count();
        assert!(
            (1800..2300).contains(&spent),
            "{spent} of 4096 are recordable"
        );
        assert!(
            (1800..2300).contains(&claim),
            "{claim} of 4096 are claimable"
        );
        assert!((900..1150).contains(&both), "{both} of 4096 are both");
    }

    #[test]
    fn the_address_depends_on_the_program_the_output_and_the_seed() {
        let mut found = (None, None, None);
        for n in 0..256 {
            let id = id(n);
            found.0 = found.0.or_else(|| address(&PROGRAM, &id));
            found.1 = found.1.or_else(|| address(&[8; 32], &id));
            found.2 = found.2.or_else(|| claim_address(&PROGRAM, &id));
        }
        let (spent, other_program, claim) = (found.0.unwrap(), found.1.unwrap(), found.2.unwrap());
        assert_ne!(spent, other_program);
        assert_ne!(spent, claim);
    }

    #[test]
    fn the_two_addresses_of_one_output_are_independent() {
        let only_spent = (0u32..64)
            .map(id)
            .find(|i| address(&PROGRAM, i).is_some() && claim_address(&PROGRAM, i).is_none());
        let only_claim = (0u32..64)
            .map(id)
            .find(|i| address(&PROGRAM, i).is_none() && claim_address(&PROGRAM, i).is_some());
        for found in [only_spent, only_claim] {
            assert!(!recordable(&PROGRAM, &found.unwrap()));
        }
    }
}

#[cfg(test)]
mod vouched_tests {
    use super::vouched_prefix;

    #[test]
    fn no_matching_record_vouches_for_nothing() {
        assert_eq!(vouched_prefix([]), 0);
        assert_eq!(vouched_prefix([(Some(1), false), (Some(2), false)]), 0);
        assert_eq!(vouched_prefix([(None, true)]), 0);
    }

    #[test]
    fn the_highest_matching_message_wins_and_gaps_are_allowed() {
        assert_eq!(
            vouched_prefix([(Some(1), true), (Some(2), false), (Some(3), true)]),
            4
        );
        assert_eq!(
            vouched_prefix([(Some(1), true), (Some(2), true), (Some(3), false)]),
            3
        );
        assert_eq!(vouched_prefix([(Some(0), true)]), 1);
    }

    #[test]
    fn a_record_that_cannot_vouch_never_counts() {
        assert_eq!(vouched_prefix([(Some(1), true), (None, true)]), 2);
    }
}
