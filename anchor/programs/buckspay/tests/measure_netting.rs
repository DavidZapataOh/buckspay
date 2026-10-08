//! M4: compute units and bytes of a netting record for n = 2..8 on both feature sets.
mod common;
use common::netting::*;
use common::zk::*;

#[test]
fn measure_record_netting() {
    for cluster in [Cluster::Devnet, Cluster::Mainnet] {
        for n in [2u8, 5, 8] {
            let mut z = Zk::new(cluster);
            let c = case(n);
            let done = z
                .send_ixs(&record_ixs(&z.gateway(), &c.statement, &c.proof))
                .unwrap();
            let fee = 5_000 * (1 + u64::from(n));
            println!(
                "M4 cluster={cluster:?} n={n} cu={} bytes={} fee_lamports={fee} rent={}",
                done.units,
                done.size,
                z.env().rent(48)
            );
        }
    }
}
