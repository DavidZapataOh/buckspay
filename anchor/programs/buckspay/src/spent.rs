//! The `Spent` accounts: one program-derived account per consumed output.
use anchor_lang::prelude::*;

use buckspay_protocol::record::RECORD_BUMP;

use crate::{
    error::BuckspayError,
    pda::create_pda,
    records::{decide, Record, RecordError},
    settlement::Presented,
    state::{Spent, SPENT_SEED},
};

/// The record address of `output`: one `create_program_address` with the fixed bump, whatever the
/// output id. An output whose address is on the curve cannot be recorded (`UnrecordableOutput`):
/// its signers choose the salt, so a search for the bump would let them choose the compute units.
pub fn address(output: &[u8; 32]) -> Result<Pubkey> {
    Pubkey::create_program_address(&[SPENT_SEED, output, &[RECORD_BUMP]], &crate::ID)
        .map_err(|_| error!(BuckspayError::UnrecordableOutput))
}

/// What an account passed as the record of an output holds, after its address, writability and
/// owner have been checked: the stored record, or nothing for an empty system account.
pub struct Slot {
    pub record: Option<Record>,
}

impl Slot {
    #[cfg(test)]
    pub fn with(record: Option<Record>) -> Self {
        Self { record }
    }
}

/// Checks that `account` is the record address of `output` and reads it.
pub fn load(account: &AccountInfo, output: &[u8; 32]) -> Result<Slot> {
    require_keys_eq!(
        account.key(),
        address(output)?,
        BuckspayError::RecordAccounts
    );
    require!(account.is_writable, BuckspayError::RecordAccounts);

    let record = if account.owner == &crate::ID {
        let data = account.try_borrow_data()?;
        let spent = Spent::try_deserialize(&mut &data[..])?;
        Some(Record {
            content: spent.content,
            flags: spent.flags,
        })
    } else {
        require_keys_eq!(
            *account.owner,
            system_program::ID,
            BuckspayError::RecordAccounts
        );
        require!(account.data_is_empty(), BuckspayError::RecordAccounts);
        None
    };
    Ok(Slot { record })
}

/// Presents one message to the record of its output, creating the record if it is new. Returns
/// whether the message is to be paid by this call.
pub fn apply<'info>(
    slot: Slot,
    account: &AccountInfo<'info>,
    presented: &Presented,
    closable_at: u32,
    payer: &Signer<'info>,
    system_program: &Program<'info, System>,
) -> Result<bool> {
    let decision =
        decide(slot.record, presented.role, presented.content).map_err(|error| match error {
            RecordError::Conflict => error!(BuckspayError::ConflictingSpend),
            RecordError::AlreadySettled => error!(BuckspayError::AlreadySettled),
        })?;
    let Some(record) = decision.write else {
        return Ok(decision.pay);
    };

    if slot.record.is_some() {
        let mut data = account.try_borrow_mut_data()?;
        let mut spent = Spent::try_deserialize(&mut &data[..])?;
        spent.flags = record.flags;
        spent.try_serialize(&mut &mut data[..])?;
    } else {
        let space = Spent::DISCRIMINATOR.len() + Spent::INIT_SPACE;
        create_pda(
            account,
            &[SPENT_SEED, &presented.output, &[RECORD_BUMP]],
            space,
            payer,
            system_program,
        )?;
        let spent = Spent {
            content: presented.content,
            payer: payer.key(),
            expiry: presented.expiry,
            closable_at,
            flags: record.flags,
        };
        let mut data = account.try_borrow_mut_data()?;
        spent.try_serialize(&mut &mut data[..])?;
    }
    Ok(decision.pay)
}

/// What a record says, as claims read it.
pub struct View {
    pub content: [u8; 32],
    pub flags: u8,
    pub expiry: u32,
}

/// The record of `output`, or `None` if nobody consumed it. The account must be at the derived
/// address; claims never write it.
pub fn read(account: &AccountInfo, output: &[u8; 32]) -> Result<Option<View>> {
    require_keys_eq!(
        account.key(),
        address(output)?,
        BuckspayError::RecordAccounts
    );
    if account.owner == &crate::ID {
        let data = account.try_borrow_data()?;
        let spent = Spent::try_deserialize(&mut &data[..])?;
        return Ok(Some(View {
            content: spent.content,
            flags: spent.flags,
            expiry: spent.expiry,
        }));
    }
    require_keys_eq!(
        *account.owner,
        system_program::ID,
        BuckspayError::RecordAccounts
    );
    require!(account.data_is_empty(), BuckspayError::RecordAccounts);
    Ok(None)
}
