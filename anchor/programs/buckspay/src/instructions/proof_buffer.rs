use anchor_lang::prelude::*;
use buckspay_zk_verify::MAX_PROOFS;

use crate::{
    clock::now,
    error::BuckspayError,
    zk::{ProofBuffer, PROOF_BUFFER_HEADER, PROOF_BUFFER_SEED, STALE_BUFFER_SECS, WIRE_LEN},
};

#[derive(Accounts)]
#[instruction(nonce: u64, len: u32)]
pub struct OpenProofBuffer<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = PROOF_BUFFER_HEADER + len as usize,
        seeds = [PROOF_BUFFER_SEED, payer.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub buffer: Account<'info, ProofBuffer>,
    pub system_program: Program<'info, System>,
}

impl OpenProofBuffer<'_> {
    pub fn process(&mut self, bumps: &OpenProofBufferBumps, nonce: u64, len: u32) -> Result<()> {
        let messages = len as usize / WIRE_LEN;
        require!(
            (len as usize).is_multiple_of(WIRE_LEN) && (2..=MAX_PROOFS).contains(&messages),
            BuckspayError::BufferLength
        );
        self.buffer.set_inner(ProofBuffer {
            payer: self.payer.key(),
            nonce,
            len,
            written: 0,
            created_at: now()?,
            bump: bumps.buffer,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct WriteProofBuffer<'info> {
    pub payer: Signer<'info>,
    #[account(
        mut,
        has_one = payer,
        seeds = [PROOF_BUFFER_SEED, payer.key().as_ref(), &buffer.nonce.to_le_bytes()],
        bump = buffer.bump,
    )]
    pub buffer: Account<'info, ProofBuffer>,
}

impl WriteProofBuffer<'_> {
    /// Writes `data` at `offset`. A write may overlap what is written but may not start past it,
    /// so a buffer is complete exactly when `written == len` and a repeated write changes nothing.
    pub fn process(&mut self, offset: u32, data: &[u8]) -> Result<()> {
        let end = u32::try_from(data.len())
            .ok()
            .and_then(|n| offset.checked_add(n))
            .filter(|end| *end <= self.buffer.len)
            .ok_or_else(|| error!(BuckspayError::BufferWrite))?;
        require!(offset <= self.buffer.written, BuckspayError::BufferWrite);
        let info = self.buffer.to_account_info();
        let mut raw = info.try_borrow_mut_data()?;
        let at = PROOF_BUFFER_HEADER + offset as usize;
        raw[at..at + data.len()].copy_from_slice(data);
        self.buffer.written = self.buffer.written.max(end);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CloseProofBuffer<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        has_one = payer,
        close = payer,
        seeds = [PROOF_BUFFER_SEED, payer.key().as_ref(), &buffer.nonce.to_le_bytes()],
        bump = buffer.bump,
    )]
    pub buffer: Account<'info, ProofBuffer>,
}

impl CloseProofBuffer<'_> {
    pub fn process(&self) -> Result<()> {
        require!(
            u64::from(now()?) >= u64::from(self.buffer.created_at) + u64::from(STALE_BUFFER_SECS),
            BuckspayError::BufferNotStale
        );
        Ok(())
    }
}
