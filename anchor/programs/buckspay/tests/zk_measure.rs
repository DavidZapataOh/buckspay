//! Compute units and transaction bytes of private settlement, per cluster, inline and through
//! the proof buffer. Run with `--nocapture`; it asserts only that each transaction lands.
#![cfg(not(feature = "short-windows"))]
mod common;
use anchor_lang::solana_program::instruction::Instruction;
use common::zk::{Cluster, Zk, ZkSettle};
use solana_message::{v1, VersionedMessage};

const V1_LIMIT: usize = 4_096;

fn v1_size(z: &Zk, ix: &Instruction) -> usize {
    let config = v1::TransactionConfig {
        compute_unit_limit: Some(1_400_000),
        loaded_accounts_data_size_limit: Some(1_024 * 1_024),
        ..v1::TransactionConfig::empty()
    };
    let message = v1::Message::try_compile_with_config(
        &z.gateway(),
        std::slice::from_ref(ix),
        Default::default(),
        config,
    )
    .unwrap();
    VersionedMessage::V1(message).serialize().len() + 64
}

#[test]
fn private_settlement_units_and_bytes() {
    for cluster in [Cluster::Devnet, Cluster::Mainnet] {
        let name = format!("{cluster:?}").to_lowercase();
        for spends in [1usize, 2, 4, 8, 9, 10, 11, 12] {
            let mut z = Zk::new(cluster);
            let note = z.private_note(spends);
            let tx = ZkSettle::inline(&z, &note);
            let bytes = v1_size(&z, &tx.ix(&z.gateway()));
            if bytes > V1_LIMIT {
                println!("{name},{spends},inline,over the limit,{bytes}");
                continue;
            }
            let landed = z.send(&tx).unwrap();
            println!("{name},{spends},inline,{},{}", landed.units, landed.size);
        }
        let mut z = Zk::new(cluster);
        let note = z.private_note(16);
        let payer = z.gateway();
        let bytes = Zk::wire_bytes(&note);
        let open = z.send_ix(z.open_ix(&payer, 1, bytes.len() as u32)).unwrap();
        println!("{name},16,open,{},{}", open.units, open.size);
        let half = bytes.len() / 2 / buckspay::zk::WIRE_LEN * buckspay::zk::WIRE_LEN;
        let mut offset = 0u32;
        for piece in [&bytes[..half], &bytes[half..]] {
            let write = z
                .send_ix(z.write_ix(&payer, 1, offset, piece.to_vec()))
                .unwrap();
            println!("{name},16,write,{},{}", write.units, write.size);
            offset += piece.len() as u32;
        }
        let buffer = common::zk::buffer_address(&payer, 1);
        let settle = z.send(&ZkSettle::from_buffer(&z, &note, buffer)).unwrap();
        println!("{name},16,buffer-settle,{},{}", settle.units, settle.size);
    }
}
