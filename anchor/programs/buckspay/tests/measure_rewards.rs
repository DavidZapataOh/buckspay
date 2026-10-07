//! Compute units and transaction size of the reward tree's append and of `claim_rewards`, on the
//! built binary and on the feature set of each live cluster.
mod common;
use common::channel::*;
use common::zk::Cluster;

/// Words of a batch whose canonical decomposition has `k` leaves: `2, 6, 14, 30, 62, 126, 254`.
fn words_for(k: u32) -> u16 {
    (1u16 << (k + 1)) - 2
}

#[test]
fn append_cost_by_leaf_count() {
    for cluster in [Cluster::Devnet, Cluster::Mainnet] {
        for k in 1..=5 {
            let mut env = ChannelEnv::new(cluster);
            let words = words_for(k);
            let cu = env.settle_words_measured(words);
            println!("{cluster:?} append leaves={k} words={words} cu={cu}");
        }
    }
}

#[test]
fn claim_cost_by_claim_count() {
    for cluster in [Cluster::Devnet, Cluster::Mainnet] {
        for k in 1..=buckspay::MAX_CLAIMS_PER_TX {
            let mut env = ChannelEnv::new(cluster);
            let leaves: Vec<_> = (0..k).map(|_| env.settled_leaf(1)).collect();
            let wallet = env.fresh_wallet_with_zero_sol();
            let claim = env.claim_many(&leaves, &wallet, env.claim_fee());
            let landed = env
                .claim(&claim)
                .unwrap_or_else(|e| panic!("claims={k}: {e:?}"));
            println!(
                "{cluster:?} claims={k} cu={} bytes={}",
                landed.units, landed.size
            );
            assert!(
                landed.units <= 1_400_000 && landed.size <= 4_096,
                "claims={k}"
            );
        }
    }
}
