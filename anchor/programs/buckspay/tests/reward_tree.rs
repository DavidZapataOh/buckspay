//! The reward tree's append, against a plain rebuild of the tree and the Go twin's vectors.
mod common;
use buckspay::rewards::{tree, RewardTree, ROOT_HISTORY};
use common::channel::rewards::tree_root;
use common::poseidon::hash;
use proptest::prelude::*;
use serde::Deserialize;

fn empty() -> RewardTree {
    bytemuck::Zeroable::zeroed()
}

fn leaf(n: u32) -> [u8; 32] {
    let mut seed = [0u8; 32];
    seed[28..].copy_from_slice(&n.to_be_bytes());
    hash(&[&seed, &seed])
}

fn latest(tree: &RewardTree) -> [u8; 32] {
    tree.roots[(tree.root_index as usize + ROOT_HISTORY - 1) % ROOT_HISTORY]
}

#[test]
fn appending_matches_the_rebuilt_tree_and_the_go_tree() {
    #[derive(Deserialize)]
    struct Vectors {
        leaves: Vec<String>,
        root: String,
    }
    let go: Vectors = serde_json::from_str(include_str!(
        "../../../../prover/testdata/claim-vectors.json"
    ))
    .unwrap();
    let leaves: Vec<[u8; 32]> = go
        .leaves
        .iter()
        .map(|l| hex::decode(l).unwrap().try_into().unwrap())
        .collect();
    let mut tree = empty();
    for (i, l) in leaves.iter().enumerate() {
        tree::append_batch(&mut tree, &[*l]).unwrap();
        assert_eq!(latest(&tree), tree_root(&leaves[..=i]), "after leaf {i}");
    }
    assert_eq!(hex::encode(latest(&tree)), go.root);
}

#[test]
fn the_ring_keeps_exactly_the_last_256_roots() {
    let mut tree = empty();
    let mut roots = vec![];
    for n in 0..300 {
        tree::append_batch(&mut tree, &[leaf(n)]).unwrap();
        roots.push(latest(&tree));
    }
    for (n, root) in roots.iter().enumerate() {
        assert_eq!(
            tree::known_root(&tree, root),
            n >= 300 - ROOT_HISTORY,
            "root {n}"
        );
    }
    assert!(!tree::known_root(&tree, &[0u8; 32]));
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(24))]

    #[test]
    fn any_split_into_batches_leaves_the_same_root_and_one_root_per_batch(
        sizes in prop::collection::vec(1usize..=7, 1..12)
    ) {
        let total: usize = sizes.iter().sum();
        let leaves: Vec<[u8; 32]> = (0..total as u32).map(leaf).collect();
        let mut tree = empty();
        let mut at = 0;
        for size in &sizes {
            tree::append_batch(&mut tree, &leaves[at..at + size]).unwrap();
            at += size;
            prop_assert_eq!(latest(&tree), tree_root(&leaves[..at]));
        }
        prop_assert_eq!(tree.root_index as usize, sizes.len());
        prop_assert_eq!(tree.next_index as usize, total);
    }
}
