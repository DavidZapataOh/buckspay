use buckspay_protocol::payword::{
    canonical_exps, leaf, node, root, verify_word, Commitment, WordProof, MAX_WORDS_PER_TX,
};
use proptest::prelude::*;

fn proof(words: &[[u8; 32]], index: u16) -> WordProof {
    let mut level: Vec<[u8; 32]> = words
        .iter()
        .enumerate()
        .map(|(i, w)| leaf(i as u16, w))
        .collect();
    let (mut at, mut path) = (usize::from(index), vec![]);
    while level.len() > 1 {
        path.push(level[at ^ 1]);
        level = level.chunks(2).map(|p| node(&p[0], &p[1])).collect();
        at /= 2;
    }
    WordProof {
        index,
        word: words[usize::from(index)],
        path,
    }
}

fn words(depth: u8, salt: u8) -> Vec<[u8; 32]> {
    (0..1u16 << depth)
        .map(|i| {
            let mut w = [salt; 32];
            w[..2].copy_from_slice(&i.to_be_bytes());
            w
        })
        .collect()
}

proptest! {
    #[test]
    fn every_word_verifies_and_no_single_change_does(
        depth in 1u8..=8,
        salt in any::<u8>(),
        pick in any::<u16>(),
        flip in any::<usize>(),
        bit in 0u8..8,
    ) {
        let ws = words(depth, salt);
        let r = root(&ws);
        let index = pick % (1 << depth);
        let good = proof(&ws, index);
        prop_assert!(verify_word(&r, depth, &good));
        let bytes = good.encode();
        let mut bad = bytes.clone();
        bad[flip % bytes.len()] ^= 1 << bit;
        let altered = WordProof::decode(&bad, depth).unwrap();
        prop_assert!(!verify_word(&r, depth, &altered));
        let other = root(&words(depth, salt.wrapping_add(1)));
        prop_assert!(!verify_word(&other, depth, &good));
    }

    #[test]
    fn a_proof_never_verifies_at_another_depth(depth in 2u8..=8, salt in any::<u8>()) {
        let ws = words(depth, salt);
        let p = proof(&ws, 1);
        prop_assert!(!verify_word(&root(&ws), depth - 1, &p));
    }

    #[test]
    fn commitments_round_trip_and_decoding_never_panics(
        mint in any::<[u8; 32]>(),
        lock_seq in any::<u32>(),
        cum_end in any::<u64>(),
        depth in 0u8..=255,
        word_value in any::<u64>(),
        r in any::<[u8; 32]>(),
        expiry in any::<u32>(),
        noise in proptest::collection::vec(any::<u8>(), 0..120),
    ) {
        let c = Commitment { mint, lock_seq, cum_end, depth, word_value, root: r, expiry };
        match Commitment::decode(&c.encode()) {
            Ok(back) => prop_assert_eq!(back, c),
            Err(_) => prop_assert!(!(4..=8).contains(&depth) || c.total().is_none()),
        }
        let _ = Commitment::decode(&noise);
    }

    #[test]
    fn the_decomposition_is_unique_and_covers_the_count(m in 0u32..400) {
        match canonical_exps(m) {
            Some(exps) => {
                prop_assert!(m % 2 == 0 && (2..=MAX_WORDS_PER_TX).contains(&m));
                prop_assert_eq!(exps.iter().map(|&e| 1u32 << e).sum::<u32>(), m);
                prop_assert!(exps.windows(2).all(|w| w[0] >= w[1]));
                prop_assert!(exps.iter().filter(|&&e| e < 7).all(|&e| exps.iter().filter(|&&x| x == e).count() == 1));
            }
            None => prop_assert!(m % 2 == 1 || m == 0 || m > MAX_WORDS_PER_TX),
        }
    }
}
