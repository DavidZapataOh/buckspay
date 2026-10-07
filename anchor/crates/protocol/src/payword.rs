//! The delivery-word channel: a payer commits to the Merkle root of independent words and a
//! relayer proves the one word it was handed. A word pays once, only its own value.
use alloc::{vec, vec::Vec};

use solana_sha256_hasher::hashv;

use crate::{
    hash,
    message::{array, kind},
    ProtocolError, Result, VERSION,
};

pub const MIN_DEPTH: u8 = 4;
pub const MAX_DEPTH: u8 = 8;
pub const MIN_LEAF_EXP: u8 = 1;
pub const MAX_LEAF_EXP: u8 = 7;
pub const MAX_WORDS_PER_TX: u32 = 256;
pub const MAX_LEAVES_PER_TX: usize = 7;
pub const COMMITMENT_LEN: usize = 91;

const LEAF_TAG: u8 = 0x00;
const NODE_TAG: u8 = 0x01;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Commitment {
    pub mint: [u8; 32],
    pub lock_seq: u32,
    pub cum_end: u64,
    pub depth: u8,
    pub word_value: u64,
    pub root: [u8; 32],
    pub expiry: u32,
}

impl Commitment {
    pub fn encode(&self) -> [u8; COMMITMENT_LEN] {
        let mut out = [0; COMMITMENT_LEN];
        out[0] = VERSION;
        out[1] = kind::PAYWORD;
        out[2..34].copy_from_slice(&self.mint);
        out[34..38].copy_from_slice(&self.lock_seq.to_le_bytes());
        out[38..46].copy_from_slice(&self.cum_end.to_le_bytes());
        out[46] = self.depth;
        out[47..55].copy_from_slice(&self.word_value.to_le_bytes());
        out[55..87].copy_from_slice(&self.root);
        out[87..91].copy_from_slice(&self.expiry.to_le_bytes());
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Commitment> {
        if bytes.len() != COMMITMENT_LEN {
            return Err(ProtocolError::Length);
        }
        if bytes[0] != VERSION {
            return Err(ProtocolError::Version);
        }
        if bytes[1] != kind::PAYWORD {
            return Err(ProtocolError::Kind);
        }
        let c = Commitment {
            mint: array(bytes, 2),
            lock_seq: u32::from_le_bytes(array(bytes, 34)),
            cum_end: u64::from_le_bytes(array(bytes, 38)),
            depth: bytes[46],
            word_value: u64::from_le_bytes(array(bytes, 47)),
            root: array(bytes, 55),
            expiry: u32::from_le_bytes(array(bytes, 87)),
        };
        if !(MIN_DEPTH..=MAX_DEPTH).contains(&c.depth) {
            return Err(ProtocolError::Depth);
        }
        c.total().ok_or(ProtocolError::Amount)?;
        Ok(c)
    }

    /// The value of every word of the channel: `2^depth * word_value`.
    pub fn total(&self) -> Option<u64> {
        1u64.checked_shl(u32::from(self.depth))
            .and_then(|words| words.checked_mul(self.word_value))
    }

    /// The lock interval the channel spends, like an issue: `[cum_end - total, cum_end)`.
    pub fn interval(&self) -> Option<(u64, u64)> {
        Some((self.cum_end.checked_sub(self.total()?)?, self.cum_end))
    }

    pub fn hash(&self) -> [u8; 32] {
        hash::content(&self.encode())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WordProof {
    pub index: u16,
    pub word: [u8; 32],
    pub path: Vec<[u8; 32]>,
}

impl WordProof {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(2 + 32 + 32 * self.path.len());
        out.extend_from_slice(&self.index.to_be_bytes());
        out.extend_from_slice(&self.word);
        for sibling in &self.path {
            out.extend_from_slice(sibling);
        }
        out
    }

    pub fn decode(bytes: &[u8], depth: u8) -> Result<WordProof> {
        if bytes.len() != 2 + 32 + 32 * usize::from(depth) {
            return Err(ProtocolError::Length);
        }
        Ok(WordProof {
            index: u16::from_be_bytes([bytes[0], bytes[1]]),
            word: array(bytes, 2),
            path: bytes[34..]
                .chunks_exact(32)
                .map(|sibling| array(sibling, 0))
                .collect(),
        })
    }
}

pub fn leaf(index: u16, word: &[u8; 32]) -> [u8; 32] {
    hashv(&[&[LEAF_TAG], &index.to_be_bytes(), word]).to_bytes()
}

pub fn node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    hashv(&[&[NODE_TAG], left, right]).to_bytes()
}

/// The root over `words.len()` leaves, which must be a power of two.
pub fn root(words: &[[u8; 32]]) -> [u8; 32] {
    let mut level: Vec<[u8; 32]> = words
        .iter()
        .enumerate()
        .map(|(i, word)| leaf(i as u16, word))
        .collect();
    while level.len() > 1 {
        level = level
            .chunks(2)
            .map(|pair| node(&pair[0], &pair[1]))
            .collect();
    }
    level.first().copied().unwrap_or_default()
}

/// Whether `p` is word `p.index` of the tree of `2^depth` words under `root`.
pub fn verify_word(root: &[u8; 32], depth: u8, p: &WordProof) -> bool {
    verify_path(root, depth, p.index, &p.word, &p.path)
}

/// The same for a word whose path is held elsewhere.
pub fn verify_path(
    root: &[u8; 32],
    depth: u8,
    index: u16,
    word: &[u8; 32],
    path: &[[u8; 32]],
) -> bool {
    if !(1..=MAX_DEPTH).contains(&depth)
        || usize::from(index) >= 1 << depth
        || path.len() != usize::from(depth)
    {
        return false;
    }
    let mut at = index;
    let mut h = leaf(index, word);
    for sibling in path {
        h = if at & 1 == 0 {
            node(&h, sibling)
        } else {
            node(sibling, &h)
        };
        at >>= 1;
    }
    h == *root
}

/// The exponents of the leaves a batch of `m` words appends: `m / 128` sevens, then the binary
/// digits of `m % 128`, descending. `None` unless `m` is even and in `2..=MAX_WORDS_PER_TX`.
pub fn canonical_exps(m: u32) -> Option<Vec<u8>> {
    if m == 0 || m & 1 == 1 || m > MAX_WORDS_PER_TX {
        return None;
    }
    let mut exps = vec![MAX_LEAF_EXP; (m / 128) as usize];
    let rest = m % 128;
    exps.extend(
        (MIN_LEAF_EXP..MAX_LEAF_EXP)
            .rev()
            .filter(|e| rest >> e & 1 == 1),
    );
    Some(exps)
}

fn envelope_with(purpose: &[u8], domain: &[u8; 32], c: &Commitment) -> Result<[u8; 96]> {
    let body = c.encode();
    let slot = hashv(&[purpose, &body]).to_bytes();
    Ok(hash::envelope(domain, &slot, &hash::content(&body)))
}

/// The envelope the issuer's device key signs for `c`. Its slot comes from the commitment, so two
/// commitments never share one.
pub fn payword_signing(domain: &[u8; 32], c: &Commitment) -> Result<[u8; 96]> {
    envelope_with(hash::purpose::PAYWORD, domain, c)
}

pub fn channels_overlap(a: (u64, u64), b: (u64, u64)) -> bool {
    a.0 < a.1 && b.0 < b.1 && a.0 < b.1 && b.0 < a.1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commitment(depth: u8) -> (Commitment, Vec<[u8; 32]>) {
        let words: Vec<[u8; 32]> = (0..1u16 << depth).map(|i| [i as u8 ^ 0x5a; 32]).collect();
        let c = Commitment {
            mint: [7; 32],
            lock_seq: 3,
            cum_end: 10_000_000,
            depth,
            word_value: 50_000,
            root: root(&words),
            expiry: 1_900_000_000,
        };
        (c, words)
    }

    fn proof(words: &[[u8; 32]], index: u16) -> WordProof {
        let mut level: Vec<[u8; 32]> = words
            .iter()
            .enumerate()
            .map(|(i, w)| leaf(i as u16, w))
            .collect();
        let (mut at, mut path) = (index as usize, vec![]);
        while level.len() > 1 {
            path.push(level[at ^ 1]);
            level = level.chunks(2).map(|p| node(&p[0], &p[1])).collect();
            at /= 2;
        }
        WordProof {
            index,
            word: words[index as usize],
            path,
        }
    }

    #[test]
    fn encode_decode_round_trip_and_kind() {
        let (c, _) = commitment(6);
        let bytes = c.encode();
        assert_eq!(bytes.len(), COMMITMENT_LEN);
        assert_eq!(bytes[1], kind::PAYWORD);
        assert_eq!(Commitment::decode(&bytes).unwrap().root, c.root);
    }

    #[test]
    fn depth_outside_min_to_eight_is_refused() {
        for depth in [0u8, 3, 9, 255] {
            let (mut c, _) = commitment(4);
            c.depth = depth;
            assert!(Commitment::decode(&c.encode()).is_err(), "depth {depth}");
        }
    }

    #[test]
    fn total_overflow_is_refused() {
        let (mut c, _) = commitment(8);
        c.word_value = u64::MAX / 128;
        assert!(c.total().is_none());
        assert!(Commitment::decode(&c.encode()).is_err());
    }

    #[test]
    fn every_word_verifies_and_only_its_own_index() {
        let (c, words) = commitment(3);
        for i in 0..8u16 {
            let p = proof(&words, i);
            assert!(verify_word(&c.root, c.depth, &p));
            let mut moved = proof(&words, i);
            moved.index = (i + 1) % 8;
            assert!(
                !verify_word(&c.root, c.depth, &moved),
                "word {i} verified at another index"
            );
        }
    }

    #[test]
    fn a_word_reveals_no_other_word() {
        let (c, words) = commitment(3);
        let p5 = proof(&words, 5);
        let forged = WordProof {
            index: 4,
            word: p5.word,
            path: p5.path.clone(),
        };
        assert!(!verify_word(&c.root, c.depth, &forged));
    }

    #[test]
    fn altered_path_short_path_and_index_out_of_range_fail() {
        let (c, words) = commitment(3);
        let mut p = proof(&words, 2);
        p.path[1][0] ^= 1;
        assert!(!verify_word(&c.root, c.depth, &p));
        let mut short = proof(&words, 2);
        short.path.pop();
        assert!(!verify_word(&c.root, c.depth, &short));
        let mut out = proof(&words, 2);
        out.index = 8;
        assert!(!verify_word(&c.root, c.depth, &out));
    }

    #[test]
    fn leaf_and_node_are_domain_separated() {
        let w = [9u8; 32];
        assert_ne!(leaf(0, &w), node(&w, &w));
    }

    #[test]
    fn interval_and_overlap() {
        let (c, _) = commitment(6);
        assert_eq!(c.interval(), Some((10_000_000 - 64 * 50_000, 10_000_000)));
        assert!(channels_overlap((0, 10), (9, 20)));
        assert!(!channels_overlap((0, 10), (10, 20)));
    }

    #[test]
    fn payword_envelope_never_equals_a_note_envelope() {
        let (c, _) = commitment(6);
        let env = payword_signing(&[1; 32], &c).unwrap();
        assert_eq!(
            env,
            envelope_with(crate::hash::purpose::PAYWORD, &[1; 32], &c).unwrap()
        );
        assert_ne!(
            env,
            envelope_with(crate::hash::purpose::NOTE, &[1; 32], &c).unwrap()
        );
        let (mut d, _) = commitment(6);
        d.expiry += 1;
        assert_ne!(env[..], payword_signing(&[1; 32], &d).unwrap()[..]);
    }

    #[test]
    fn canonical_exps_is_the_unique_minimal_decomposition() {
        assert_eq!(canonical_exps(2), Some(vec![1]));
        assert_eq!(canonical_exps(6), Some(vec![2, 1]));
        assert_eq!(canonical_exps(254), Some(vec![7, 6, 5, 4, 3, 2, 1]));
        assert_eq!(canonical_exps(256), Some(vec![7, 7]));
        for m in [0u32, 1, 3, 255, 258] {
            assert_eq!(canonical_exps(m), None, "m = {m}");
        }
        for m in (2..=MAX_WORDS_PER_TX).step_by(2) {
            let e = canonical_exps(m).unwrap();
            assert!(e.len() <= MAX_LEAVES_PER_TX && e.windows(2).all(|w| w[0] >= w[1]));
            assert!(e.iter().all(|x| (MIN_LEAF_EXP..=MAX_LEAF_EXP).contains(x)));
            assert_eq!(e.iter().map(|&x| 1u32 << x).sum::<u32>(), m);
        }
    }

    #[test]
    fn a_word_verifies_only_under_its_own_root() {
        let (c, words) = commitment(4);
        let other: Vec<[u8; 32]> = words
            .iter()
            .map(|w| {
                let mut x = *w;
                x[0] ^= 1;
                x
            })
            .collect();
        let p = proof(&words, 2);
        assert!(verify_word(&c.root, c.depth, &p));
        assert!(!verify_word(&root(&other), c.depth, &p));
    }

    #[test]
    fn word_proof_round_trips_and_refuses_a_wrong_length() {
        let (c, words) = commitment(4);
        let p = proof(&words, 9);
        let bytes = p.encode();
        assert_eq!(bytes.len(), 2 + 32 + 4 * 32);
        let back = WordProof::decode(&bytes, c.depth).unwrap();
        assert!(verify_word(&c.root, c.depth, &back));
        assert!(WordProof::decode(&bytes[1..], c.depth).is_err());
        assert!(WordProof::decode(&bytes, c.depth + 1).is_err());
    }
}
