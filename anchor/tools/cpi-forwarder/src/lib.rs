//! Forwards its instruction data to another program by CPI, with every account it was given: the
//! first 32 bytes of the data name the target, the rest is the instruction data it receives.
use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
};

entrypoint!(process);

fn process(_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (target, data) = data
        .split_first_chunk::<32>()
        .ok_or(ProgramError::InvalidInstructionData)?;
    let target = Pubkey::new_from_array(*target);
    let metas = accounts
        .iter()
        .filter(|account| account.key != &target)
        .map(|account| AccountMeta {
            pubkey: *account.key,
            is_signer: account.is_signer,
            is_writable: account.is_writable,
        })
        .collect();
    invoke(
        &Instruction {
            program_id: target,
            accounts: metas,
            data: data.to_vec(),
        },
        accounts,
    )
}
