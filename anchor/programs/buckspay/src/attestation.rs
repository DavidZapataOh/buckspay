//! What the attester instructions share: reading a ticket's verification from the instructions
//! sysvar, deciding from accounts whether the lock a ticket names exists, the canonical-key check,
//! and the one way an attester is slashed.
use anchor_lang::prelude::*;
use buckspay_protocol::{attest::LockRecord, BondTicket};
use solana_curve25519::edwards::{
    add_edwards, multiply_edwards, validate_edwards, PodEdwardsPoint,
};
use solana_curve25519::scalar::PodScalar;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::{
    error::BuckspayError,
    state::{Device, Lock},
};

fn is_unused(account: &AccountInfo) -> bool {
    *account.owner == anchor_lang::system_program::ID && account.data_is_empty()
}

const KEY_OFFSET: usize = 16;
const SIGNATURE_OFFSET: usize = KEY_OFFSET + 32;
const MESSAGE_OFFSET: usize = SIGNATURE_OFFSET + 64;
const MESSAGE_LEN: usize = 32 + BondTicket::BODY_LEN;
const ED25519_DATA_LEN: usize = MESSAGE_OFFSET + MESSAGE_LEN;

/// One signature, every field inline (`u16::MAX` instruction indices), the layout
/// `new_ed25519_instruction_with_signature` produces.
const ED25519_HEADER: [u8; KEY_OFFSET] = {
    let fields = [
        SIGNATURE_OFFSET as u16,
        u16::MAX,
        KEY_OFFSET as u16,
        u16::MAX,
        MESSAGE_OFFSET as u16,
        MESSAGE_LEN as u16,
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

/// Requires that the instruction right before the current one is the Ed25519 verification of
/// `ticket`'s signature over its signed message by one of `keys`, and nothing else: one signature,
/// every offset inline, exactly the bytes `new_ed25519_instruction_with_signature` produces. The
/// precompile cannot be called from a program, and it has already failed the transaction if the
/// signature does not verify.
pub fn require_ticket_signature(
    instructions: &AccountInfo,
    ticket: &BondTicket,
    keys: &[Option<[u8; 32]>; 2],
) -> Result<()> {
    let current = usize::from(load_current_index_checked(instructions)?);
    let previous = current.checked_sub(1).ok_or(BuckspayError::TicketBinding)?;
    let instruction = load_instruction_at_checked(previous, instructions)?;
    let message = ticket.signed_message(&crate::ticket_domain());
    let data = &instruction.data;
    let exact = instruction.program_id == solana_sdk_ids::ed25519_program::ID
        && data.len() == ED25519_DATA_LEN
        && data[..KEY_OFFSET] == ED25519_HEADER
        && data[SIGNATURE_OFFSET..MESSAGE_OFFSET] == ticket.signature
        && data[MESSAGE_OFFSET..] == message;
    require!(exact, BuckspayError::TicketBinding);
    let signer = &data[KEY_OFFSET..SIGNATURE_OFFSET];
    require!(
        keys.iter().flatten().any(|key| key[..] == *signer),
        BuckspayError::UnknownSigner
    );
    Ok(())
}

/// The `Lock` at the ticket's seeds, or `None` if the address holds nothing.
pub fn read_lock(account: &AccountInfo) -> Result<Option<LockRecord>> {
    if *account.owner == crate::ID {
        let lock = Lock::try_deserialize(&mut &account.try_borrow_data()?[..])?;
        return Ok(Some(LockRecord {
            mint: lock.mint.to_bytes(),
            bond: lock.bond,
            backing: lock.backing,
            lock_until: lock.lock_until,
        }));
    }
    require!(is_unused(account), BuckspayError::RecordAccounts);
    Ok(None)
}

/// The device's `next_lock_seq`, or `None` if the device is not registered.
pub fn read_counter(account: &AccountInfo) -> Result<Option<u32>> {
    if *account.owner == crate::ID {
        let device = Device::try_deserialize(&mut &account.try_borrow_data()?[..])?;
        return Ok(Some(device.next_lock_seq));
    }
    require!(is_unused(account), BuckspayError::RecordAccounts);
    Ok(None)
}

const IDENTITY: PodEdwardsPoint = PodEdwardsPoint({
    let mut one = [0; 32];
    one[0] = 1;
    one
});

/// `L - 1`, little endian, where `L` is the order of the prime-order subgroup.
const L_MINUS_ONE: PodScalar = PodScalar([
    0xec, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10,
]);

/// Whether `key` is a canonical encoding of a point of the prime-order subgroup other than the
/// identity, which is what the receivers and the Ed25519 precompile agree on: the point decodes,
/// adding the identity returns the same bytes (so the encoding is canonical), and
/// `(L - 1) * A + A` is the identity, so `L * A` is, so `A` has no torsion component (and a
/// torsion-free point of small order is the identity).
pub fn is_prime_order_key(key: &[u8; 32]) -> bool {
    let point = PodEdwardsPoint(*key);
    if point == IDENTITY || !validate_edwards(&point) {
        return false;
    }
    if add_edwards(&point, &IDENTITY) != Some(point) {
        return false;
    }
    let Some(negated) = multiply_edwards(&L_MINUS_ONE, &point) else {
        return false;
    };
    add_edwards(&point, &negated) == Some(IDENTITY)
}
