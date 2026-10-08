use anchor_lang::prelude::*;
use buckspay_protocol::{netting::NettingStatement, record::RECORD_BUMP};
use buckspay_zk_verify::{verify_netting_raw_with, vk, NETTING_PROOF_RAW};

use crate::{
    clock::now,
    error::BuckspayError,
    netting::{self, Netting, NETTING_KEEP_SECS, NETTING_SEED},
    pda::create_pda,
};

/// Records a circular netting: the statement is public, every participant signed it, and one proof says the
/// cancellations under its root are a circulation. Nothing is paid and no pause applies: a record commits only
/// what all participants signed.
#[derive(Accounts)]
pub struct RecordNetting<'info> {
    /// Pays the rent of the record and gets it back when the record is closed.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the record address of the statement, checked and created by the handler.
    #[account(mut)]
    pub netting: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar, pinned by address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> RecordNetting<'info> {
    pub fn process(&mut self, statement: &[u8], proof: &[u8; NETTING_PROOF_RAW]) -> Result<()> {
        let statement = NettingStatement::decode(statement)
            .map_err(|_| error!(BuckspayError::NettingStatement))?;
        require!(netting::keys_allowed(), BuckspayError::NettingProof);
        let now = now()?;
        require!(now < statement.expires, BuckspayError::NettingExpired);

        let content = statement.content();
        let message = statement.envelope(&crate::netting_domain());
        netting::require_signatures(&self.instructions, &statement, &message)?;
        verify_netting_raw_with(&vk::NETTING_VK, &[*proof], &[statement.public_inputs()])
            .map_err(|_| error!(BuckspayError::NettingProof))?;

        require_keys_eq!(
            self.netting.key(),
            netting::address(&content)?,
            BuckspayError::NettingAddress
        );
        require_keys_eq!(
            *self.netting.owner,
            system_program::ID,
            BuckspayError::NettingAddress
        );
        require!(self.netting.data_is_empty(), BuckspayError::NettingAddress);
        create_pda(
            &self.netting,
            &[NETTING_SEED, &content, &[RECORD_BUMP]],
            8 + Netting::INIT_SPACE,
            &self.payer,
            &self.system_program,
        )?;
        let record = Netting {
            payer: self.payer.key(),
            recorded_at: now,
            closable_at: statement.expires.saturating_add(NETTING_KEEP_SECS),
        };
        let mut data = self.netting.try_borrow_mut_data()?;
        record.try_serialize(&mut &mut data[..])
    }
}
