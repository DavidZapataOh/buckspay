//! Rust client of the Buckspay program: the Codama-generated code in `generated`, plus what Codama
//! cannot express.

mod generated;

pub use generated::*;

use solana_address::Address;
use solana_instruction::Instruction;

/// Seed prefixes of the program's accounts.
pub const DEVICE_SEED: &[u8] = b"device";
pub const ROTATION_SEED: &[u8] = b"rotation";
pub const LOCK_SEED: &[u8] = b"lock";
pub const LEDGER_SEED: &[u8] = b"ledger";
pub const ESCROW_SEED: &[u8] = b"escrow";

/// The `Device` account of a 33-byte device key and its canonical bump: seeds
/// `["device", key[..1], key[1..]]` (Codama cannot express sliced seeds).
pub fn find_device_pda(key: &[u8; 33]) -> (Address, u8) {
    Program::new(BUCKSPAY_ID).find_device_pda(key)
}

/// The compute unit limit of a registration for a key whose device account has the canonical bump
/// `bump`: the most expensive registration (onto a device account address someone prefunded) plus
/// 4,500 CU of instructions a wallet may add, and at least 40,000 CU. Equal to the app's
/// `registerDeviceComputeUnitLimit`.
pub fn register_device_compute_unit_limit(bump: u8) -> u32 {
    (11_281 + 1_500 * u32::from(255 - bump) + 4_500).max(40_000)
}

/// A deployment of the program. The generated builders target `BUCKSPAY_ID`, the production
/// program; the short-windows build has an id of its own, and its addresses and instructions
/// follow it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Program(Address);

impl Program {
    pub fn new(id: Address) -> Self {
        Self(id)
    }

    pub fn id(&self) -> Address {
        self.0
    }

    pub fn find_device_pda(&self, key: &[u8; 33]) -> (Address, u8) {
        Address::find_program_address(&[DEVICE_SEED, &key[..1], &key[1..]], &self.0)
    }

    pub fn find_rotation_pda(&self, key: &[u8; 33]) -> (Address, u8) {
        Address::find_program_address(&[ROTATION_SEED, &key[..1], &key[1..]], &self.0)
    }

    pub fn find_lock_pda(&self, key: &[u8; 33], lock_seq: u32) -> (Address, u8) {
        Address::find_program_address(
            &[LOCK_SEED, &key[..1], &key[1..], &lock_seq.to_le_bytes()],
            &self.0,
        )
    }

    pub fn find_ledger_pda(&self, lock: &Address) -> (Address, u8) {
        Address::find_program_address(&[LEDGER_SEED, lock.as_ref()], &self.0)
    }

    pub fn find_escrow_pda(&self, lock: &Address) -> (Address, u8) {
        Address::find_program_address(&[ESCROW_SEED, lock.as_ref()], &self.0)
    }

    /// An instruction a generated builder made, for this deployment: its program, and the
    /// placeholder an absent optional account is passed as, are this program's id.
    pub fn target(&self, mut instruction: Instruction) -> Instruction {
        instruction.program_id = self.0;
        for meta in &mut instruction.accounts {
            if meta.pubkey == BUCKSPAY_ID {
                meta.pubkey = self.0;
            }
        }
        instruction
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use instructions::CreateLockBuilder;

    #[test]
    fn addresses_and_instructions_follow_the_deployment() {
        let short = Program::new(Address::new_from_array([7; 32]));
        let key = [2; 33];
        assert_eq!(
            Program::new(BUCKSPAY_ID).find_device_pda(&key),
            find_device_pda(&key)
        );
        assert_ne!(short.find_device_pda(&key), find_device_pda(&key));
        let (lock, _) = short.find_lock_pda(&key, 3);
        assert_ne!(short.find_ledger_pda(&lock), short.find_escrow_pda(&lock));
        assert_ne!(
            short.find_rotation_pda(&key).0,
            short.find_device_pda(&key).0
        );

        let address = |n| Address::new_from_array([n; 32]);
        let ix = CreateLockBuilder::new()
            .wallet(address(1))
            .payer(address(2))
            .device(address(3))
            .lock(address(4))
            .ledger(address(5))
            .escrow(address(6))
            .mint(address(8))
            .funder(address(9))
            .token_program(address(10))
            .key(key)
            .lock_seq(0)
            .bond(1)
            .backing(1)
            .lock_until(1)
            .sponsor_fee(0)
            .instruction();
        let placeholder =
            |ix: &Instruction, id| ix.accounts.iter().filter(|m| m.pubkey == id).count();
        assert_eq!(placeholder(&ix, BUCKSPAY_ID), 1, "the absent fee recipient");
        let targeted = short.target(ix);
        assert_eq!(targeted.program_id, short.id());
        assert_eq!(placeholder(&targeted, BUCKSPAY_ID), 0);
        assert_eq!(placeholder(&targeted, short.id()), 1);
    }
}
