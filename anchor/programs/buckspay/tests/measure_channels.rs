//! Compute units and transaction size of `settle_channel` on the built binary, on both clusters.
mod common;
use common::channel::*;
use common::zk::Cluster;

fn measure(cluster: Cluster, depth: u8, channels: usize, words: u16, again: bool) -> (u64, usize) {
    let mut env = ChannelEnv::new(cluster);
    let chans: Vec<PayerChannel> = (0..channels).map(|_| env.payer_channel(depth)).collect();
    let batch = |first: bool, indexes: &[u16]| {
        let mut s = Settle::new();
        for c in &chans {
            s = if first {
                s.first(c, indexes)
            } else {
                s.again(c, indexes)
            };
        }
        s.inners_for((indexes.len() * channels) as u32)
    };
    if again {
        env.send(batch(true, &[14, 15]))
            .unwrap_or_else(|e| panic!("{e:?}"));
    }
    let indexes: Vec<u16> = (0..words).collect();
    let landed = env
        .send(batch(!again, &indexes))
        .unwrap_or_else(|e| panic!("{e:?}"));
    (landed.units, landed.size)
}

/// Sizes that must fit one transaction v1 (4,096 bytes), and sizes that are measured only: four
/// channels of four words carry more word proofs than a transaction holds, so a submitter packs
/// by size.
const FITS: [(u8, usize, u16); 5] = [(4, 1, 2), (4, 1, 8), (4, 1, 16), (4, 2, 4), (4, 4, 2)];
const MEASURED: [(u8, usize, u16); 3] = [(4, 3, 4), (4, 4, 4), (8, 1, 8)];

#[test]
fn settle_channel_fits_its_budgets() {
    for cluster in [Cluster::Devnet, Cluster::Mainnet] {
        for (depth, channels, words) in FITS.into_iter().chain(MEASURED) {
            let (cu, bytes) = measure(cluster, depth, channels, words, false);
            println!(
                "{cluster:?} depth={depth} channels={channels} words={} cu={cu} bytes={bytes}",
                channels as u16 * words
            );
            assert!(cu <= 1_000_000);
            assert!(bytes <= 4_096 || !FITS.contains(&(depth, channels, words)));
        }
        let (cu, bytes) = measure(cluster, 4, 2, 4, true);
        println!("{cluster:?} depth=4 later batch channels=2 words=8 cu={cu} bytes={bytes}");
        assert!(bytes <= 4_096 && cu <= 1_000_000);
    }
}
