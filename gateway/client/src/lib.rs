//! Rust client of the Buckspay program: the Codama-generated code in `generated`, plus what Codama
//! cannot express.

mod generated;

pub use generated::*;

use solana_address::Address;

/// Seed prefix of `Device` accounts.
pub const DEVICE_SEED: &[u8] = b"device";

/// The `Device` account of a 33-byte device key and its canonical bump: seeds
/// `["device", key[..1], key[1..]]` (Codama cannot express sliced seeds).
pub fn find_device_pda(key: &[u8; 33]) -> (Address, u8) {
    Address::find_program_address(&[DEVICE_SEED, &key[..1], &key[1..]], &BUCKSPAY_ID)
}

/// The compute unit limit of a registration for a key whose device account has the canonical bump
/// `bump`: the most expensive registration (onto a device account address someone prefunded) plus
/// 4,500 CU of instructions a wallet may add, and at least 40,000 CU. Equal to the app's
/// `registerDeviceComputeUnitLimit`.
pub fn register_device_compute_unit_limit(bump: u8) -> u32 {
    (10_833 + 1_500 * u32::from(255 - bump) + 4_500).max(40_000)
}
