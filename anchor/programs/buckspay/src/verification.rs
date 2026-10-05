//! Reading the secp256r1 precompile's instructions from the instructions sysvar. The precompile
//! cannot be called from a program, so a program checks that the transaction carries a
//! verification of exactly the message it expects.
use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

const KEY_LEN: usize = 33;
const KEY_OFFSET: usize = 16;
const SIGNATURE_OFFSET: usize = KEY_OFFSET + KEY_LEN;
const MESSAGE_OFFSET: usize = SIGNATURE_OFFSET + 64;
const ENVELOPE_LEN: usize = 96;
const SECP256R1_DATA_LEN: usize = MESSAGE_OFFSET + ENVELOPE_LEN;

/// One signature, every field inline (`u16::MAX` instruction indices), in the layout
/// `new_secp256r1_instruction_with_signature` produces.
const SECP256R1_HEADER: [u8; KEY_OFFSET] = {
    let fields = [
        SIGNATURE_OFFSET as u16,
        u16::MAX,
        KEY_OFFSET as u16,
        u16::MAX,
        MESSAGE_OFFSET as u16,
        ENVELOPE_LEN as u16,
        u16::MAX,
    ];
    let mut header = [0; KEY_OFFSET];
    header[0] = 1;
    let mut i = 0;
    while i < fields.len() {
        let bytes = fields[i].to_le_bytes();
        header[2 + 2 * i] = bytes[0];
        header[3 + 2 * i] = bytes[1];
        i += 1;
    }
    header
};

/// Whether `data` is the inline verification of `key` over `message` and nothing else: one
/// signature, every offset inline, exactly the 209 bytes `new_secp256r1_instruction_with_signature`
/// produces.
fn is_verification(data: &[u8], key: &[u8; KEY_LEN], message: &[u8; ENVELOPE_LEN]) -> bool {
    data.len() == SECP256R1_DATA_LEN
        && data[..KEY_OFFSET] == SECP256R1_HEADER
        && data[KEY_OFFSET..SIGNATURE_OFFSET] == key[..]
        && data[MESSAGE_OFFSET..] == message[..]
}

/// Requires exactly one secp256r1 verification of `key` over `message` before the current
/// instruction, wherever it is: wallets may add their own instructions around ours, and
/// verifications of other messages are not this one's. Returns `error` otherwise.
pub fn require_one_verification(
    instructions: &AccountInfo,
    key: &[u8; KEY_LEN],
    message: &[u8; ENVELOPE_LEN],
    error: Error,
) -> Result<()> {
    let current = load_current_index_checked(instructions)?;
    let mut matching = 0;
    for index in 0..usize::from(current) {
        let instruction = load_instruction_at_checked(index, instructions)?;
        if instruction.program_id == solana_sdk_ids::secp256r1_program::ID
            && is_verification(&instruction.data, key, message)
        {
            matching += 1;
        }
    }
    if matching == 1 {
        Ok(())
    } else {
        Err(error)
    }
}
