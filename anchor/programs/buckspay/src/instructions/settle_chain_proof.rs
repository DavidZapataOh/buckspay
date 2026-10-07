use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use buckspay_protocol::{
    attest::MAX_NOTE_LIFE,
    window::{self, Settle},
    GRACE,
};
use buckspay_zk_verify::{
    consumed_outputs, public_inputs, verify_batch_with, vk, vk::Vk, ChainContext, MessagePublic,
    VerifyError, MAX_PROOFS, PROOF_COMPRESSED,
};

use crate::{
    clock::now,
    error::BuckspayError,
    note_domain,
    payout::pay_out,
    pda::create_pda,
    records::{decide, Role},
    settlement::{load_slots, present, Presented},
    state::{Ledger, Lock, ESCROW_SEED, LEDGER_SEED, LOCK_SEED},
    zk::{
        self, ProofBuffer, WireMessage, ZkConfig, ZkLockDraws, PROOF_BUFFER_HEADER, WIRE_LEN,
        ZK_CAP_WINDOW_SECS, ZK_CONFIG_SEED, ZK_DRAWS_SEED,
    },
};

#[derive(Accounts)]
#[instruction(vk_sha256: [u8; 32], issuer_key: [u8; 33], lock_seq: u32)]
pub struct SettleChainProof<'info> {
    /// Pays the rent of the records and of the draws account; the fee payer in the usual case.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [ZK_CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ZkConfig>>,
    /// CHECK: the per-mint account, read and checked in the handler so that its absence is
    /// reported as `MintNotEnabled`.
    #[account(mut)]
    pub zk_mint: UncheckedAccount<'info>,
    #[account(
        seeds = [LOCK_SEED, &issuer_key[..1], &issuer_key[1..], &lock_seq.to_le_bytes()],
        bump = lock.bump,
    )]
    pub lock: Box<Account<'info, Lock>>,
    #[account(mut, seeds = [LEDGER_SEED, lock.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, lock.key().as_ref()],
        bump = lock.escrow_bump,
        token::mint = lock.mint,
        token::authority = ledger,
        token::token_program = token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = lock.mint, mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// Any token account of the mint; the handler requires its owner to be the account the note
    /// pays, which the proofs bind.
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
        constraint = destination.key() != escrow.key() @ BuckspayError::WrongPayee,
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
        constraint = fee_account.key() != escrow.key() @ BuckspayError::WrongFeeAccount,
    )]
    pub fee_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the lock's draws account at its derived address, created on first use.
    #[account(mut)]
    pub draws: UncheckedAccount<'info>,
    /// The messages, when they did not fit the transaction; closed to its payer, who is the signer.
    #[account(mut, constraint = buffer.payer == payer.key() @ BuckspayError::BufferIncomplete)]
    pub buffer: Option<Account<'info, ProofBuffer>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

fn verify_error(error: VerifyError) -> Error {
    match error {
        VerifyError::NonCanonical => error!(BuckspayError::NonCanonicalPublic),
        VerifyError::Input
        | VerifyError::KeyShape
        | VerifyError::Empty
        | VerifyError::TooMany
        | VerifyError::Mismatch => {
            error!(BuckspayError::ChainInvalid)
        }
        VerifyError::BadPoint | VerifyError::Pairing => error!(BuckspayError::ProofRejected),
    }
}

/// The messages of the settlement: the ones in the instruction, or the ones of the buffer.
fn messages(
    inline: Vec<WireMessage>,
    buffer: Option<&Account<ProofBuffer>>,
) -> Result<Vec<WireMessage>> {
    let Some(buffer) = buffer else {
        return Ok(inline);
    };
    require!(inline.is_empty(), BuckspayError::ChainInvalid);
    require!(
        buffer.written == buffer.len,
        BuckspayError::BufferIncomplete
    );
    let info = buffer.to_account_info();
    let raw = info.try_borrow_data()?;
    let mut out = Vec::with_capacity(buffer.len as usize / WIRE_LEN);
    for chunk in
        raw[PROOF_BUFFER_HEADER..PROOF_BUFFER_HEADER + buffer.len as usize].chunks_exact(WIRE_LEN)
    {
        out.push(WireMessage::from_bytes(chunk)?);
    }
    Ok(out)
}

impl<'info> SettleChainProof<'info> {
    /// The key a batch is verified under: the one this program carries, or the previous one while
    /// the notes made under it can still settle.
    fn key(&self, vk_sha256: &[u8; 32], now: u32) -> Result<Vk<'static>> {
        if vk_sha256 == vk::VK.sha256 {
            require!(
                self.config.current.vk == *vk_sha256,
                BuckspayError::StaleVerifyingKey
            );
            return Ok(vk::VK);
        }
        let previous = vk::PREVIOUS
            .filter(|key| key.sha256 == vk_sha256 && self.config.previous.vk == *vk_sha256);
        let until = self
            .config
            .rotated_at
            .saturating_add(i64::from(MAX_NOTE_LIFE) + i64::from(GRACE));
        match previous {
            Some(key) if self.config.rotated_at != 0 && i64::from(now) <= until => Ok(key),
            _ => Err(error!(BuckspayError::StaleVerifyingKey)),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn process(
        &mut self,
        vk_sha256: [u8; 32],
        issuer_key: [u8; 33],
        lock_seq: u32,
        amount: u64,
        cum_end: u64,
        pay_amount: u64,
        expiry: u32,
        inline: Vec<WireMessage>,
        records: &[AccountInfo<'info>],
    ) -> Result<()> {
        require!(!self.config.paused, BuckspayError::ZkPaused);
        let now = now()?;
        let key = self.key(&vk_sha256, now)?;

        let wire = messages(inline, self.buffer.as_ref())?;
        require!(
            (2..=MAX_PROOFS).contains(&wire.len()),
            BuckspayError::ChainInvalid
        );
        require!(
            cum_end <= self.lock.backing && self.mint.key() == self.lock.mint,
            BuckspayError::WrongLock
        );
        let mint_info = self.zk_mint.to_account_info();
        let mut zk_mint = zk::read_mint(&mint_info, &self.mint.key())?;
        require_keys_eq!(
            self.fee_account.key(),
            zk_mint.fee_account,
            BuckspayError::WrongFeeAccount
        );
        match window::settle(expiry, self.lock.lock_until, now) {
            Settle::Open => {}
            Settle::LockEnded => return Err(error!(BuckspayError::LockEnded)),
            Settle::Closed => return Err(error!(BuckspayError::SettlementClosed)),
        }

        let context = ChainContext {
            domain: note_domain(),
            issuer_key,
            mint: self.lock.mint.to_bytes(),
            lock_seq,
            amount,
            cum_end,
            payee: self.destination.owner.to_bytes(),
            pay_amount,
            expiry,
        };
        let public: Vec<MessagePublic> = wire
            .iter()
            .map(|m| MessagePublic {
                content: m.content,
                next_bit: m.next_bit,
                s_out: m.s_out,
            })
            .collect();
        let publics = public_inputs(&context, &public).map_err(verify_error)?;
        let proofs: Vec<[u8; PROOF_COMPRESSED]> = wire.iter().map(|m| m.proof).collect();
        verify_batch_with(&key, &proofs, &publics).map_err(verify_error)?;
        let consumed = consumed_outputs(&context, &public).map_err(verify_error)?;

        let last = consumed.len() - 1;
        let presented: Vec<Presented> = consumed
            .iter()
            .zip(&wire[1..])
            .enumerate()
            .map(|(i, (output, message))| Presented {
                output: *output,
                content: message.content,
                expiry: self.lock.lock_until,
                role: if i == last { Role::Final } else { Role::Prefix },
                message: None,
            })
            .collect();
        let slots = load_slots(&presented, records)?;
        let mut created = 0u64;
        for (p, slot) in presented.iter().zip(&slots) {
            decide(slot.record, p.role, p.content).map_err(|error| match error {
                crate::records::RecordError::Conflict => error!(BuckspayError::ConflictingSpend),
                crate::records::RecordError::AlreadySettled => {
                    error!(BuckspayError::AlreadySettled)
                }
            })?;
            created += u64::from(slot.record.is_none());
        }

        let fee = zk_mint
            .record_fee
            .checked_mul(created)
            .ok_or_else(|| error!(BuckspayError::AmountOverflow))?;
        require!(pay_amount > fee, BuckspayError::BelowRecordFee);
        let draws_info = self.draws.to_account_info();
        let mut draws = self.draws(&draws_info)?;
        draws.window.admit(
            i64::from(now),
            pay_amount,
            zk_mint.lock_cap,
            ZK_CAP_WINDOW_SECS,
        )?;
        zk_mint.window.admit(
            i64::from(now),
            pay_amount,
            zk_mint.global_cap,
            ZK_CAP_WINDOW_SECS,
        )?;

        present(
            &presented,
            slots,
            records,
            &self.payer,
            &self.system_program,
            self.lock.lock_until,
        )?;
        zk::write(&mint_info, &zk_mint)?;
        zk::write(&draws_info, &draws)?;

        let net = self.ledger.pay_backing(pay_amount - fee)?;
        pay_out(
            &self.ledger,
            &self.lock.key(),
            &mut self.escrow,
            &self.mint,
            &self.destination,
            &self.token_program,
            net,
        )?;
        if fee > 0 {
            let withheld = self.ledger.pay_backing(fee)?;
            pay_out(
                &self.ledger,
                &self.lock.key(),
                &mut self.escrow,
                &self.mint,
                &self.fee_account,
                &self.token_program,
                withheld,
            )?;
        }
        if let Some(buffer) = &self.buffer {
            buffer.close(self.payer.to_account_info())?;
        }
        Ok(())
    }

    /// The lock's draws account, created on the first private settlement of the lock.
    fn draws(&self, info: &AccountInfo<'info>) -> Result<ZkLockDraws> {
        let lock = self.lock.key();
        if info.owner == &crate::ID {
            let draws: ZkLockDraws = zk::read(info)?;
            let address = Pubkey::create_program_address(
                &[ZK_DRAWS_SEED, lock.as_ref(), &[draws.bump]],
                &crate::ID,
            )
            .map_err(|_| error!(BuckspayError::RecordAccounts))?;
            require_keys_eq!(info.key(), address, BuckspayError::RecordAccounts);
            return Ok(draws);
        }
        let (address, bump) =
            Pubkey::find_program_address(&[ZK_DRAWS_SEED, lock.as_ref()], &crate::ID);
        require_keys_eq!(info.key(), address, BuckspayError::RecordAccounts);
        require!(info.data_is_empty(), BuckspayError::RecordAccounts);
        create_pda(
            info,
            &[ZK_DRAWS_SEED, lock.as_ref(), &[bump]],
            8 + ZkLockDraws::INIT_SPACE,
            &self.payer,
            &self.system_program,
        )?;
        Ok(ZkLockDraws {
            window: zk::Window::default(),
            bump,
        })
    }
}
