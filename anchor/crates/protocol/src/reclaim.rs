use crate::{hash, kind, VERSION};

pub const BODY_LEN: usize = 6;

/// `ver ‖ kind ‖ deadline:u32 LE`. The signed facts are the slot (the output being reclaimed) and
/// the last second at which the signature may be used; the payout goes to the wallet bound to the
/// signing key, so the message names no destination.
pub fn reclaim_body(deadline: u32) -> [u8; BODY_LEN] {
    let d = deadline.to_le_bytes();
    [VERSION, kind::RECLAIM, d[0], d[1], d[2], d[3]]
}

/// `DOMAIN(reclaim) ‖ output id ‖ SHA-256(body)`, the message the owner of `output` signs to
/// take it back once nobody settled it in time.
pub fn reclaim_envelope(domain_reclaim: &[u8; 32], output: &[u8; 32], deadline: u32) -> [u8; 96] {
    hash::envelope(
        domain_reclaim,
        output,
        &hash::content(&reclaim_body(deadline)),
    )
}

/// What a reclaim leaves in the record of the output it takes back: `SHA-256(ver ‖ kind)`, the
/// same for every reclaim, so two reclaims of one output are one message whatever their deadlines.
/// It is never the content of a spend.
pub fn record_content() -> [u8; 32] {
    hash::content(&[VERSION, kind::RECLAIM])
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use crate::cluster::DEVNET_GENESIS_HASH;
    use crate::hash::{content, domain, purpose};

    const DEADLINE: u32 = 1_900_000_000;

    #[test]
    fn body_is_version_kind_and_deadline() {
        assert_eq!(reclaim_body(DEADLINE), [1, 0x60, 0x00, 0xb3, 0x3f, 0x71]);
        assert_eq!(reclaim_body(0x0102_0304)[2..], [4, 3, 2, 1]);
    }

    #[test]
    fn envelope_is_reclaim_domain_output_and_content() {
        let d = domain(purpose::RECLAIM, &DEVNET_GENESIS_HASH, &[7; 32]);
        let e = reclaim_envelope(&d, &[5; 32], DEADLINE);
        assert_eq!(e[..32], d);
        assert_eq!(e[32..64], [5; 32]);
        assert_eq!(e[64..], content(&reclaim_body(DEADLINE)));
    }

    #[test]
    fn the_deadline_is_signed() {
        let d = domain(purpose::RECLAIM, &DEVNET_GENESIS_HASH, &[7; 32]);
        assert_ne!(
            reclaim_envelope(&d, &[5; 32], DEADLINE),
            reclaim_envelope(&d, &[5; 32], DEADLINE + 1)
        );
    }

    #[test]
    fn a_reclaim_is_never_a_spend_or_another_purposes_message() {
        let output = [5; 32];
        let reclaim = domain(purpose::RECLAIM, &DEVNET_GENESIS_HASH, &[7; 32]);
        let note = domain(purpose::NOTE, &DEVNET_GENESIS_HASH, &[7; 32]);
        assert_ne!(
            reclaim_envelope(&reclaim, &output, DEADLINE)[..32],
            reclaim_envelope(&note, &output, DEADLINE)[..32]
        );
        assert_ne!(reclaim_body(DEADLINE)[1], kind::SPEND1);
        assert_ne!(reclaim_body(DEADLINE)[1], kind::SPEND2);
    }

    #[test]
    fn a_reclaim_with_a_two_byte_body_never_matches() {
        let d = domain(purpose::RECLAIM, &DEVNET_GENESIS_HASH, &[7; 32]);
        let old = hash::envelope(&d, &[5; 32], &content(&[VERSION, kind::RECLAIM]));
        assert_ne!(old, reclaim_envelope(&d, &[5; 32], 0));
    }

    #[test]
    fn the_record_content_is_one_constant() {
        assert_eq!(record_content(), content(&[1, 0x60]));
        assert_ne!(record_content(), content(&reclaim_body(DEADLINE)));
    }

    fn hex(bytes: &[u8]) -> std::string::String {
        use std::fmt::Write;
        bytes.iter().fold(std::string::String::new(), |mut out, b| {
            write!(out, "{b:02x}").unwrap();
            out
        })
    }

    #[test]
    fn golden_vectors_match_an_independent_computation() {
        let d = domain(purpose::RECLAIM, &DEVNET_GENESIS_HASH, &[7; 32]);
        assert_eq!(
            hex(&d),
            "50fd7e8dfff080a5fc229a35250545f9cc1e8e31896d6b6b56cc0a2c941d3801"
        );
        assert_eq!(hex(&reclaim_body(DEADLINE)), "016000b33f71");
        let e = reclaim_envelope(&d, &[5; 32], DEADLINE);
        assert_eq!(
            hex(&e[64..]),
            "6b2832539449afe253738010bcaaa4e969f5d2d1ba496639c2025df962c8f759"
        );
        assert_eq!(
            hex(&record_content()),
            "cbcaf5c8e65193d0481411b9f202ad6223374b17ea7d7451ccb6d4d7ab022949"
        );
    }
}
