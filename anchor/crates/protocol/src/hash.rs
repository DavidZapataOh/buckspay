use solana_sha256_hasher::hashv;

const DOMAIN_TAG: &[u8] = b"BUCKSPAY:v1:";
const OUTPUT_TAG: &[u8] = b"BPO1";

pub mod purpose {
    pub const NOTE: &[u8] = b"note";
    pub const TICKET: &[u8] = b"ticket";
    pub const DEVICE: &[u8] = b"device";
    pub const WITNESS: &[u8] = b"witness";
    pub const RECLAIM: &[u8] = b"reclaim";
    pub const PAYWORD: &[u8] = b"payword";
    pub const IOU: &[u8] = b"iou";
    pub const VOICE: &[u8] = b"voice";
    pub const CLAIM: &[u8] = b"claim";
    pub const REVOKE: &[u8] = b"revoke";
}

pub fn domain(purpose: &[u8], genesis_hash: &[u8; 32], program_id: &[u8; 32]) -> [u8; 32] {
    hashv(&[DOMAIN_TAG, purpose, genesis_hash, program_id]).to_bytes()
}

pub fn content(body: &[u8]) -> [u8; 32] {
    hashv(&[body]).to_bytes()
}

pub fn envelope(domain: &[u8; 32], slot: &[u8; 32], content: &[u8; 32]) -> [u8; 96] {
    let mut out = [0; 96];
    out[..32].copy_from_slice(domain);
    out[32..64].copy_from_slice(slot);
    out[64..].copy_from_slice(content);
    out
}

pub fn message_id(envelope: &[u8; 96]) -> [u8; 32] {
    hashv(&[envelope]).to_bytes()
}

pub fn output_id(message_id: &[u8; 32], index: u8) -> [u8; 32] {
    hashv(&[OUTPUT_TAG, message_id, &[index]]).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cluster::{DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH};

    const PROGRAM: [u8; 32] = [7; 32];
    const PURPOSES: [&[u8]; 10] = [
        purpose::NOTE,
        purpose::TICKET,
        purpose::DEVICE,
        purpose::WITNESS,
        purpose::RECLAIM,
        purpose::PAYWORD,
        purpose::IOU,
        purpose::VOICE,
        purpose::CLAIM,
        purpose::REVOKE,
    ];

    #[test]
    fn domain_separates_purposes() {
        for (i, a) in PURPOSES.iter().enumerate() {
            for b in &PURPOSES[i + 1..] {
                assert_ne!(
                    domain(a, &DEVNET_GENESIS_HASH, &PROGRAM),
                    domain(b, &DEVNET_GENESIS_HASH, &PROGRAM)
                );
            }
        }
    }

    #[test]
    fn domain_separates_clusters_and_programs() {
        let note = |genesis: &[u8; 32], program: &[u8; 32]| domain(purpose::NOTE, genesis, program);
        assert_ne!(
            note(&DEVNET_GENESIS_HASH, &PROGRAM),
            note(&MAINNET_GENESIS_HASH, &PROGRAM)
        );
        assert_ne!(
            note(&DEVNET_GENESIS_HASH, &PROGRAM),
            note(&DEVNET_GENESIS_HASH, &[8; 32])
        );
    }

    #[test]
    fn envelope_is_domain_slot_content() {
        let e = envelope(&[1; 32], &[2; 32], &[3; 32]);
        assert_eq!(&e[..32], &[1; 32]);
        assert_eq!(&e[32..64], &[2; 32]);
        assert_eq!(&e[64..], &[3; 32]);
    }

    #[test]
    fn output_ids_differ_by_index() {
        let id = message_id(&[0; 96]);
        assert_ne!(output_id(&id, 0), output_id(&id, 1));
    }

    #[test]
    fn content_is_sha256() {
        assert_eq!(
            content(b"abc"),
            [
                0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae,
                0x22, 0x23, 0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61,
                0xf2, 0x00, 0x15, 0xad
            ]
        );
    }
}
