//! The canonical layout of one secp256r1 precompile instruction that carries every signature,
//! key and message inline. The gateway writes it and the program checks it, so the two cannot
//! drift apart.
//!
//! ```text
//! [count: u8][0: u8][offsets: 14 bytes × count][key 33 ‖ signature 64 ‖ message 96] × count
//! ```
//!
//! For one signature this is exactly what `new_secp256r1_instruction_with_signature` produces.

/// The precompile verifies at most this many signatures per instruction.
pub const MAX_SIGNATURES: usize = 8;
pub const KEY_LEN: usize = 33;
pub const SIGNATURE_LEN: usize = 64;
pub const MESSAGE_LEN: usize = 96;
const OFFSETS_START: usize = 2;
const OFFSETS_LEN: usize = 14;
const BLOCK_LEN: usize = KEY_LEN + SIGNATURE_LEN + MESSAGE_LEN;

/// A key and the 96-byte envelope it must have signed.
pub type Expected = ([u8; KEY_LEN], [u8; MESSAGE_LEN]);

/// Length of the instruction data for `count` signatures.
pub const fn data_len(count: usize) -> usize {
    OFFSETS_START + count * (OFFSETS_LEN + BLOCK_LEN)
}

fn block_start(index: usize, count: usize) -> usize {
    OFFSETS_START + count * OFFSETS_LEN + index * BLOCK_LEN
}

fn offsets(index: usize, count: usize) -> [u8; OFFSETS_LEN] {
    let key = block_start(index, count);
    let fields = [
        (key + KEY_LEN) as u16,
        u16::MAX,
        key as u16,
        u16::MAX,
        (key + KEY_LEN + SIGNATURE_LEN) as u16,
        MESSAGE_LEN as u16,
        u16::MAX,
    ];
    let mut out = [0; OFFSETS_LEN];
    for (i, field) in fields.iter().enumerate() {
        out[2 * i..2 * i + 2].copy_from_slice(&field.to_le_bytes());
    }
    out
}

/// Writes the instruction data for `entries` with their `signatures` into `out`, which must be
/// exactly `data_len(entries.len())` long. Returns `None` for an empty or oversized batch, a
/// wrong buffer length or a different number of signatures.
pub fn write(
    out: &mut [u8],
    entries: &[Expected],
    signatures: &[[u8; SIGNATURE_LEN]],
) -> Option<()> {
    let count = entries.len();
    if count == 0
        || count > MAX_SIGNATURES
        || signatures.len() != count
        || out.len() != data_len(count)
    {
        return None;
    }
    out[0] = count as u8;
    out[1] = 0;
    for (i, ((key, message), signature)) in entries.iter().zip(signatures).enumerate() {
        let at = OFFSETS_START + i * OFFSETS_LEN;
        out[at..at + OFFSETS_LEN].copy_from_slice(&offsets(i, count));
        let block = block_start(i, count);
        out[block..block + KEY_LEN].copy_from_slice(key);
        out[block + KEY_LEN..block + KEY_LEN + SIGNATURE_LEN].copy_from_slice(signature);
        out[block + KEY_LEN + SIGNATURE_LEN..block + BLOCK_LEN].copy_from_slice(message);
    }
    Some(())
}

/// Whether `data` is the verification of exactly `entries`, in order and in the canonical layout.
/// Signature bytes are not compared: the precompile has verified whatever they are. The precompile
/// ignores `data[1]` and trailing bytes, so this requires both to be exactly as `write` makes them.
pub fn matches(data: &[u8], entries: &[Expected]) -> bool {
    let count = entries.len();
    if count == 0 || count > MAX_SIGNATURES || data.len() != data_len(count) {
        return false;
    }
    if data[0] != count as u8 || data[1] != 0 {
        return false;
    }
    entries.iter().enumerate().all(|(i, (key, message))| {
        let at = OFFSETS_START + i * OFFSETS_LEN;
        let block = block_start(i, count);
        data[at..at + OFFSETS_LEN] == offsets(i, count)
            && data[block..block + KEY_LEN] == key[..]
            && data[block + KEY_LEN + SIGNATURE_LEN..block + BLOCK_LEN] == message[..]
    })
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use std::{vec, vec::Vec};

    fn entries(n: usize) -> ([Expected; MAX_SIGNATURES], [[u8; 64]; MAX_SIGNATURES]) {
        let mut e = [([0; 33], [0; 96]); MAX_SIGNATURES];
        let mut s = [[0; 64]; MAX_SIGNATURES];
        for i in 0..n {
            e[i] = ([i as u8 + 1; 33], [i as u8 + 0x40; 96]);
            s[i] = [i as u8 + 0x80; 64];
        }
        (e, s)
    }

    fn built(n: usize) -> Vec<u8> {
        let (e, s) = entries(n);
        let mut out = vec![0; data_len(n)];
        write(&mut out, &e[..n], &s[..n]).unwrap();
        out
    }

    #[test]
    fn lengths() {
        assert_eq!(data_len(1), 209);
        assert_eq!(data_len(2), 416);
        assert_eq!(data_len(8), 1_658);
    }

    #[test]
    fn a_written_batch_matches_for_every_count() {
        for n in 1..=MAX_SIGNATURES {
            let (e, _) = entries(n);
            assert!(matches(&built(n), &e[..n]), "{n}");
        }
    }

    #[test]
    fn every_byte_but_the_signatures_is_pinned() {
        for n in [1, 2, 3, 8] {
            let (e, _) = entries(n);
            let data = built(n);
            for at in 0..data.len() {
                let in_signature = (0..n).any(|i| {
                    let s = block_start(i, n) + KEY_LEN;
                    (s..s + SIGNATURE_LEN).contains(&at)
                });
                let mut mutated = data.clone();
                mutated[at] ^= 1;
                assert_eq!(matches(&mutated, &e[..n]), in_signature, "n={n} byte {at}");
            }
        }
    }

    #[test]
    fn length_count_and_order_are_pinned() {
        let (e, _) = entries(3);
        let data = built(3);
        assert!(!matches(&data[..data.len() - 1], &e[..3]));
        let mut longer = data.clone();
        longer.push(0);
        assert!(!matches(&longer, &e[..3]));
        assert!(!matches(&data, &e[..2]));
        let swapped = [e[1], e[0], e[2]];
        assert!(!matches(&data, &swapped));
        assert!(!matches(&[], &[]));
        assert!(!matches(&built(1), &[]));
    }

    #[test]
    fn write_refuses_what_the_precompile_would() {
        let (e, s) = entries(8);
        assert!(write(&mut [], &[], &[]).is_none());
        let mut out = vec![0; data_len(8)];
        assert!(write(&mut out, &e[..8], &s[..8]).is_some());
        let nine = [e[0]; 9];
        let nine_s = [s[0]; 9];
        let mut big = vec![0; data_len(9)];
        assert!(write(&mut big, &nine, &nine_s).is_none());
        let mut short = vec![0; data_len(2) - 1];
        assert!(write(&mut short, &e[..2], &s[..2]).is_none());
        let mut ok = vec![0; data_len(2)];
        assert!(write(&mut ok, &e[..2], &s[..1]).is_none());
    }

    #[test]
    fn one_signature_is_what_the_standard_builder_produces() {
        let message = [7u8; 96];
        let key = [3u8; 33];
        let signature = [9u8; 64];
        let standard = solana_secp256r1_program::new_secp256r1_instruction_with_signature(
            &message, &signature, &key,
        );
        let mut ours = vec![0; data_len(1)];
        write(&mut ours, &[(key, message)], &[signature]).unwrap();
        assert_eq!(ours, standard.data);
    }
}
