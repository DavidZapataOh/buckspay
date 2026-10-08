//! M5: the most one-hop settle_note instructions one transaction v1 carries, and with a lookup table (v0).
mod common;
use buckspay_protocol::NO_LOCK;
use common::zk::*;
use common::*;
use solana_message::{v0, AddressLookupTableAccount, VersionedMessage};
use solana_signer::Signer;

#[test]
fn measure_group_settlement() {
    for cluster in [Cluster::Devnet, Cluster::Mainnet] {
        let mut largest = 0;
        let mut largest_v0 = 0;
        for k in 1..=12u8 {
            let mut env = Env::new_on(cluster.svm(), MintSetup::classic());
            let mut ixs = Vec::new();
            for i in 0..k {
                let issuer = env.issuer(10 + i, 100_000_000, 1_000_000_000, 60);
                let holder = Key::new(60 + i);
                let payee = Pubkey::new_unique();
                let dest = env.token_account_of(&payee, 0);
                let expiry = expiry_of(&env, 10);
                let note = Chain::issue(
                    &issuer.key,
                    &env.mint,
                    0,
                    0,
                    1_000_000,
                    holder.owner(),
                    caveats(expiry, 12),
                )
                .spend1_to_account(&holder, 0, &payee, NO_LOCK, 99);
                let payer = env.payer.pubkey();
                ixs.extend(settle_ixs(&env, &payer, &issuer, &note, &dest));
            }
            let table = vec![
                anchor_spl::token::ID,
                solana_sdk_ids::system_program::ID,
                solana_instructions_sysvar::ID,
                env.mint,
            ];
            let alt = AddressLookupTableAccount {
                key: Pubkey::new_unique(),
                addresses: table,
            };
            let v0_bytes =
                v0::Message::try_compile(&env.payer.pubkey(), &ixs, &[alt], Default::default())
                    .map(|m| 1 + 64 + VersionedMessage::V0(m).serialize().len())
                    .unwrap_or(usize::MAX);
            if v0_bytes <= 1_232 {
                largest_v0 = k;
            }
            println!("M5 cluster={cluster:?} k={k} v0_with_table_bytes={v0_bytes}");
            match env.send_v1(&ixs) {
                Ok(done) => {
                    if done.size <= 4_096 {
                        largest = k;
                    }
                    println!(
                        "M5 cluster={cluster:?} k={k} cu={} bytes={}",
                        done.units, done.size
                    );
                }
                Err(error) => {
                    println!("M5 cluster={cluster:?} k={k} refused: {error:?}");
                    break;
                }
            }
        }
        println!("M5 cluster={cluster:?} largest_k_within_4096={largest} largest_k_v0_with_table={largest_v0}");
    }
}
