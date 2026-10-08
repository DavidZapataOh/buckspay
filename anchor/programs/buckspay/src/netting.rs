//! Netting records: the proof of a circular netting and the signature of every participant, kept as one small
//! account per statement.
use anchor_lang::prelude::*;
use buckspay_protocol::{netting::NettingStatement, record::RECORD_BUMP};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::error::BuckspayError;

pub use buckspay_protocol::record::NETTING_SEED;

/// How long a record outlives the expiry of its statement: inside `[expires, closable_at)` an absent account
/// means the netting is void.
#[cfg(not(feature = "short-windows"))]
pub const NETTING_KEEP_SECS: u32 = 30 * 86_400;
#[cfg(feature = "short-windows")]
pub const NETTING_KEEP_SECS: u32 = 120;

/// A netting that landed before its statement expired.
#[account]
#[derive(InitSpace)]
pub struct Netting {
    /// Gets the rent back.
    pub payer: Pubkey,
    pub recorded_at: u32,
    /// `expires + NETTING_KEEP_SECS`, saturating.
    pub closable_at: u32,
}

/// The record address of `content`, or `NettingAddress` when it is on the curve: its signers choose the
/// statement, so a search for the bump would let them choose the compute units.
pub fn address(content: &[u8; 32]) -> Result<Pubkey> {
    Pubkey::create_program_address(&[NETTING_SEED, content, &[RECORD_BUMP]], &crate::ID)
        .map_err(|_| error!(BuckspayError::NettingAddress))
}

/// Whether netting proofs verified under the compiled key are acceptable on this cluster.
pub fn keys_allowed() -> bool {
    crate::zk::keys_permitted(
        buckspay_zk_verify::vk::NETTING_TEST_KEYS,
        &crate::GENESIS_HASH,
    )
}

const MAX_HEADER: usize = 2 + 14 * buckspay_protocol::netting::MAX_PARTICIPANTS;
const SIGNATURE_ENTRY: usize = 32 + 64;
const MESSAGE_LEN: usize = 96;

/// The offsets table of the one Ed25519 instruction layout a record accepts, and its length: `n` signatures,
/// every field inline (`u16::MAX` instruction indices), the keys and signatures interleaved, one 96-byte message
/// shared by all of them at the end.
pub fn ed25519_header(n: usize) -> ([u8; MAX_HEADER], usize) {
    let base = 2 + 14 * n;
    let message = base + SIGNATURE_ENTRY * n;
    let mut header = [0u8; MAX_HEADER];
    header[0] = n as u8;
    for i in 0..n {
        let key = base + SIGNATURE_ENTRY * i;
        let fields = [
            key + 32,
            usize::from(u16::MAX),
            key,
            usize::from(u16::MAX),
            message,
            MESSAGE_LEN,
            usize::from(u16::MAX),
        ];
        for (k, field) in fields.iter().enumerate() {
            let at = 2 + 14 * i + 2 * k;
            header[at..at + 2].copy_from_slice(&(*field as u16).to_le_bytes());
        }
    }
    (header, base)
}

/// Requires that the instruction right before the current one is the Ed25519 verification of every
/// participant's signature over `message`, in exactly the layout of [`ed25519_header`] with key `i` the
/// statement's `ephemeral[i]`. The signatures themselves are not read: the precompile has already failed the
/// transaction if one does not verify.
pub fn require_signatures(
    instructions: &AccountInfo,
    statement: &NettingStatement,
    message: &[u8; 96],
) -> Result<()> {
    let n = usize::from(statement.participants);
    let current = usize::from(load_current_index_checked(instructions)?);
    let previous = current
        .checked_sub(1)
        .ok_or(BuckspayError::NettingSignatures)?;
    let instruction = load_instruction_at_checked(previous, instructions)?;
    let (header, base) = ed25519_header(n);
    let data = &instruction.data;
    let exact = instruction.program_id == solana_sdk_ids::ed25519_program::ID
        && data.len() == base + (SIGNATURE_ENTRY * n) + MESSAGE_LEN
        && data[..base] == header[..base]
        && data[base + SIGNATURE_ENTRY * n..] == message[..];
    require!(exact, BuckspayError::NettingSignatures);
    for (i, key) in statement.ephemeral.iter().take(n).enumerate() {
        let at = base + SIGNATURE_ENTRY * i;
        require!(
            data[at..at + 32] == key[..],
            BuckspayError::NettingSignatures
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use buckspay_protocol::cluster::{DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH};

    #[test]
    fn test_keys_refused_on_mainnet_genesis() {
        assert!(!crate::zk::keys_permitted(true, &MAINNET_GENESIS_HASH));
        assert!(crate::zk::keys_permitted(true, &DEVNET_GENESIS_HASH));
        assert_eq!(
            keys_allowed(),
            crate::zk::keys_permitted(
                buckspay_zk_verify::vk::NETTING_TEST_KEYS,
                &crate::GENESIS_HASH
            )
        );
    }

    #[test]
    fn ed25519_layout_offsets() {
        let (header, len) = ed25519_header(2);
        let expected: [u8; 30] = [
            2, 0, //
            62, 0, 0xff, 0xff, 30, 0, 0xff, 0xff, 222, 0, 96, 0, 0xff,
            0xff, // key at 30, signature at 62, message at 222
            158, 0, 0xff, 0xff, 126, 0, 0xff, 0xff, 222, 0, 96, 0, 0xff, 0xff,
        ];
        assert_eq!((&header[..len], len), (&expected[..], 30));
    }
}
