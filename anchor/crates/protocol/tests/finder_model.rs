//! Any tree of spends, settled in any order with first-settled-wins records, some records closed or
//! reclaimed: the finder names only owners who signed two contents for one output.
use buckspay_protocol::record::{first_conflict, RecordRef};
use proptest::prelude::*;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug)]
struct Branch {
    /// The output each spend consumes and the content it signs, in order.
    hops: Vec<(u32, [u8; 32])>,
}

/// Builds `forks + 1` branches: a base of `len` hops, then each fork copies a prefix of an earlier
/// branch and signs another content for the next output (its owner double spends).
fn tree(len: usize, forks: &[(usize, usize, usize)]) -> Vec<Branch> {
    let mut next = 0u32;
    let mut fresh = |n: usize, tag: u8| -> Vec<(u32, [u8; 32])> {
        (0..n)
            .map(|_| {
                next += 1;
                let mut content = [tag; 32];
                content[..4].copy_from_slice(&next.to_le_bytes());
                (next, content)
            })
            .collect()
    };
    let mut branches = vec![Branch {
        hops: fresh(len, 0),
    }];
    for (i, &(parent, at, tail)) in forks.iter().enumerate() {
        let p = branches[parent % branches.len()].clone();
        let at = at % p.hops.len();
        let mut hops = p.hops[..at].to_vec();
        let mut other = p.hops[at].1;
        other[31] = other[31].wrapping_add(1 + i as u8);
        hops.push((p.hops[at].0, other));
        hops.extend(fresh(tail, 1 + i as u8));
        branches.push(Branch { hops });
    }
    branches
}

/// Settles or records a prefix of each attempted branch in order: a walk that meets a record with
/// another content writes nothing; otherwise it writes every record it walked.
fn run(branches: &[Branch], attempts: &[(usize, usize)]) -> HashMap<u32, [u8; 32]> {
    let mut records = HashMap::new();
    for &(b, cut) in attempts {
        let hops = &branches[b % branches.len()].hops;
        let walked = &hops[..1 + cut % hops.len()];
        if walked
            .iter()
            .any(|(o, c)| records.get(o).is_some_and(|r| r != c))
        {
            continue;
        }
        for (o, c) in walked {
            records.entry(*o).or_insert(*c);
        }
    }
    records
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(4_096))]
    #[test]
    fn the_finder_never_names_an_honest_owner(
        len in 1usize..=16,
        forks in prop::collection::vec((0usize..8, 0usize..16, 0usize..8), 0..5),
        attempts in prop::collection::vec((0usize..8, 0usize..16), 1..12),
        closed in prop::collection::vec(0u32..60, 0..6),
        reclaimed in prop::collection::vec(0u32..60, 0..6),
    ) {
        let branches = tree(len, &forks);
        let mut records = run(&branches, &attempts);
        for output in &closed {
            records.remove(output);
        }
        let reclaimed: HashSet<u32> = reclaimed.into_iter().collect();
        let mut signed: HashMap<u32, HashSet<[u8; 32]>> = HashMap::new();
        for b in &branches {
            for (o, c) in &b.hops {
                signed.entry(*o).or_default().insert(*c);
            }
        }
        for b in &branches {
            let contents: Vec<[u8; 32]> = b.hops.iter().map(|h| h.1).collect();
            let recs: Vec<Option<RecordRef>> = b
                .hops
                .iter()
                .map(|(o, _)| {
                    records.get(o).map(|c| RecordRef {
                        content: *c,
                        reclaimed: reclaimed.contains(o),
                    })
                })
                .collect();
            let differs = |r: &Option<RecordRef>, c: &[u8; 32]| {
                r.as_ref().is_some_and(|r| !r.reclaimed && &r.content != c)
            };
            match first_conflict(&contents, &recs) {
                Some(i) => {
                    prop_assert!(signed[&b.hops[i].0].len() >= 2, "honest owner named at hop {i}");
                    prop_assert!(differs(&recs[i], &contents[i]));
                    prop_assert!(!recs[..i].iter().zip(&contents).any(|(r, c)| differs(r, c)));
                }
                None => prop_assert!(!recs.iter().zip(&contents).any(|(r, c)| differs(r, c))),
            }
        }
    }
}
