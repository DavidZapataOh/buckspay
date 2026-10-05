//! The transactions the gateway prepares and the app rebuilds byte for byte: each is a compute
//! budget pair, then the program's instructions, with the gateway as fee payer and as the
//! program's `payer`, and the wallet a read-only signer.
use crate::message;
use buckspay_client::{
    Program,
    instructions::{
        ApplyWalletRotationBuilder, CancelWalletRotationBuilder, CloseLockBuilder,
        CloseSpentBuilder, CreateLockBuilder, ReclaimOutputBuilder, RegisterDeviceBuilder,
        ReleaseLockBuilder, RequestWalletRotationBuilder, SettleNoteBuilder, WithdrawLockBuilder,
    },
    types::Link,
};
use buckspay_protocol::secp256r1;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_hash::Hash;
use solana_instruction::AccountMeta;
use solana_instruction::Instruction;
use solana_message::VersionedMessage;
use solana_pubkey::Pubkey;
use solana_secp256r1_program::new_secp256r1_instruction_with_signature;

/// A lock to create: what the wallet asks to fund and the accounts it funds it from.
#[derive(Clone, Copy, Debug)]
pub struct NewLock {
    pub wallet: Pubkey,
    pub key: [u8; 33],
    pub lock_seq: u32,
    pub funder: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub bond: u64,
    pub backing: u64,
    pub lock_until: u32,
    /// The fee paid to `sponsor_token` on top of `bond + backing`, with the account that gets it.
    pub sponsor_fee: u64,
    pub sponsor_token: Option<Pubkey>,
}

/// A signature of the device key over an envelope, as the secp256r1 precompile verifies it.
#[derive(Clone, Copy, Debug)]
pub struct DeviceSignature<'a> {
    pub key: &'a [u8; 33],
    pub envelope: &'a [u8; 96],
    pub signature: &'a [u8; 64],
}

impl DeviceSignature<'_> {
    fn verification(&self) -> Instruction {
        new_secp256r1_instruction_with_signature(self.envelope, self.signature, self.key)
    }
}

pub fn create_lock(program: &Program, fee_payer: &Pubkey, lock: &NewLock) -> Instruction {
    let (device, _) = program.find_device_pda(&lock.key);
    let (address, _) = program.find_lock_pda(&lock.key, lock.lock_seq);
    let mut builder = CreateLockBuilder::new();
    builder
        .wallet(lock.wallet)
        .payer(*fee_payer)
        .device(device)
        .lock(address)
        .ledger(program.find_ledger_pda(&address).0)
        .escrow(program.find_escrow_pda(&address).0)
        .mint(lock.mint)
        .funder(lock.funder)
        .sponsor_token(lock.sponsor_token)
        .token_program(lock.token_program)
        .key(lock.key)
        .lock_seq(lock.lock_seq)
        .bond(lock.bond)
        .backing(lock.backing)
        .lock_until(lock.lock_until)
        .sponsor_fee(lock.sponsor_fee);
    program.target(builder.instruction())
}

/// `[secp256r1 verification of the binding, register_device, create_lock]`: the registration and
/// the first lock of a key, which land together or not at all.
pub fn onboarding(
    program: &Program,
    fee_payer: &Pubkey,
    binding: DeviceSignature,
    lock: &NewLock,
) -> Vec<Instruction> {
    let (device, _) = program.find_device_pda(&lock.key);
    let mut register = RegisterDeviceBuilder::new();
    register
        .wallet(lock.wallet)
        .payer(*fee_payer)
        .device(device)
        .key(lock.key);
    vec![
        binding.verification(),
        program.target(register.instruction()),
        create_lock(program, fee_payer, lock),
    ]
}

/// A withdrawal of lock `lock_seq` to the wallet's `destination`.
#[derive(Clone, Copy, Debug)]
pub struct Withdrawal {
    pub wallet: Pubkey,
    pub rent_receiver: Pubkey,
    pub key: [u8; 33],
    pub lock_seq: u32,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub destination: Pubkey,
}

pub fn withdrawal(program: &Program, withdrawal: &Withdrawal) -> Instruction {
    let (lock, _) = program.find_lock_pda(&withdrawal.key, withdrawal.lock_seq);
    let mut builder = WithdrawLockBuilder::new();
    builder
        .wallet(withdrawal.wallet)
        .device(program.find_device_pda(&withdrawal.key).0)
        .lock(lock)
        .ledger(program.find_ledger_pda(&lock).0)
        .escrow(program.find_escrow_pda(&lock).0)
        .mint(withdrawal.mint)
        .destination(withdrawal.destination)
        .rent_receiver(withdrawal.rent_receiver)
        .token_program(withdrawal.token_program)
        .key(withdrawal.key)
        .lock_seq(withdrawal.lock_seq);
    program.target(builder.instruction())
}

/// `[secp256r1 verification of the rotation, request_wallet_rotation]`.
pub fn rotation_request(
    program: &Program,
    fee_payer: &Pubkey,
    new_wallet: &Pubkey,
    rotation: DeviceSignature,
) -> Vec<Instruction> {
    let mut builder = RequestWalletRotationBuilder::new();
    builder
        .new_wallet(*new_wallet)
        .payer(*fee_payer)
        .device(program.find_device_pda(rotation.key).0)
        .rotation(program.find_rotation_pda(rotation.key).0)
        .key(*rotation.key);
    vec![
        rotation.verification(),
        program.target(builder.instruction()),
    ]
}

/// `cancel_wallet_rotation`, whose rent goes back to `rent_receiver`, the account that paid it.
pub fn rotation_cancel(
    program: &Program,
    wallet: &Pubkey,
    rent_receiver: &Pubkey,
    key: &[u8; 33],
) -> Instruction {
    let mut builder = CancelWalletRotationBuilder::new();
    builder
        .wallet(*wallet)
        .device(program.find_device_pda(key).0)
        .rotation(program.find_rotation_pda(key).0)
        .rent_receiver(*rent_receiver)
        .key(*key);
    program.target(builder.instruction())
}

/// The message to sign: the compute unit limit and price, then `instructions`, compiled the way
/// `@solana/kit` 7 compiles them.
pub fn compose(
    fee_payer: &Pubkey,
    compute_unit_limit: u32,
    compute_unit_price: u64,
    instructions: &[Instruction],
    blockhash: Hash,
) -> VersionedMessage {
    let mut all = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(compute_unit_limit),
        ComputeBudgetInstruction::set_compute_unit_price(compute_unit_price),
    ];
    all.extend_from_slice(instructions);
    message::compile(fee_payer, &all, blockhash)
}

/// `release_lock`: anyone may pay a lock's remaining funds to its wallet once the release delay has
/// passed.
pub fn release(program: &Program, withdrawal: &Withdrawal) -> Instruction {
    let (lock, _) = program.find_lock_pda(&withdrawal.key, withdrawal.lock_seq);
    let mut builder = ReleaseLockBuilder::new();
    builder
        .device(program.find_device_pda(&withdrawal.key).0)
        .lock(lock)
        .ledger(program.find_ledger_pda(&lock).0)
        .escrow(program.find_escrow_pda(&lock).0)
        .mint(withdrawal.mint)
        .destination(withdrawal.destination)
        .rent_receiver(withdrawal.rent_receiver)
        .token_program(withdrawal.token_program)
        .key(withdrawal.key)
        .lock_seq(withdrawal.lock_seq);
    program.target(builder.instruction())
}

/// `close_lock`: closes a withdrawn lock's records to whoever paid them.
pub fn close(
    program: &Program,
    key: &[u8; 33],
    lock_seq: u32,
    rent_receiver: &Pubkey,
) -> Instruction {
    let (lock, _) = program.find_lock_pda(key, lock_seq);
    let mut builder = CloseLockBuilder::new();
    builder
        .lock(lock)
        .ledger(program.find_ledger_pda(&lock).0)
        .escrow(program.find_escrow_pda(&lock).0)
        .rent_receiver(*rent_receiver)
        .key(*key)
        .lock_seq(lock_seq);
    program.target(builder.instruction())
}

/// `apply_wallet_rotation`: nobody signs; the rotation's rent goes back to `rent_receiver`.
pub fn apply_rotation(program: &Program, key: &[u8; 33], rent_receiver: &Pubkey) -> Instruction {
    let mut builder = ApplyWalletRotationBuilder::new();
    builder
        .device(program.find_device_pda(key).0)
        .rotation(program.find_rotation_pda(key).0)
        .rent_receiver(*rent_receiver)
        .key(*key);
    program.target(builder.instruction())
}

/// What a settlement or a reclaim names besides the chain: the lock it draws on and where it pays.
#[derive(Clone, Copy, Debug)]
pub struct Payout {
    pub payer: Pubkey,
    pub lock: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub destination: Pubkey,
}

fn records(records: &[Pubkey]) -> Vec<AccountMeta> {
    records
        .iter()
        .map(|record| AccountMeta::new(*record, false))
        .collect()
}

/// The verification of `entries` by the secp256r1 precompile in the canonical layout the program
/// reads: every key, envelope and signature inline.
pub fn chain_verification(
    entries: &[secp256r1::Expected],
    signatures: &[[u8; secp256r1::SIGNATURE_LEN]],
) -> Option<Instruction> {
    let mut data = vec![0; secp256r1::data_len(entries.len())];
    secp256r1::write(&mut data, entries, signatures)?;
    Some(Instruction {
        program_id: solana_secp256r1_program::ID,
        accounts: vec![],
        data,
    })
}

/// `settle_note`: pays the account the last spend names, and records every consumed output.
pub fn settle_note(
    program: &Program,
    payout: &Payout,
    issue: [u8; 163],
    spends: Vec<Link>,
    consumed: &[Pubkey],
) -> Instruction {
    let mut builder = SettleNoteBuilder::new();
    builder
        .payer(payout.payer)
        .lock(payout.lock)
        .ledger(program.find_ledger_pda(&payout.lock).0)
        .escrow(program.find_escrow_pda(&payout.lock).0)
        .mint(payout.mint)
        .destination(payout.destination)
        .token_program(payout.token_program)
        .issue(issue)
        .spends(spends)
        .add_remaining_accounts(&records(consumed));
    program.target(builder.instruction())
}

/// `reclaim_output`: pays the wallet `owner` is bound to what nobody settled.
#[allow(clippy::too_many_arguments)]
pub fn reclaim_output(
    program: &Program,
    payout: &Payout,
    owner: [u8; 33],
    issue: [u8; 163],
    spends: Vec<Link>,
    which: u8,
    deadline: u32,
    consumed: &[Pubkey],
) -> Instruction {
    let mut builder = ReclaimOutputBuilder::new();
    builder
        .payer(payout.payer)
        .device(program.find_device_pda(&owner).0)
        .lock(payout.lock)
        .ledger(program.find_ledger_pda(&payout.lock).0)
        .escrow(program.find_escrow_pda(&payout.lock).0)
        .mint(payout.mint)
        .destination(payout.destination)
        .token_program(payout.token_program)
        .owner(owner)
        .issue(issue)
        .spends(spends)
        .which(which)
        .deadline(deadline)
        .add_remaining_accounts(&records(consumed));
    program.target(builder.instruction())
}

/// `close_spent` for the records of `pairs`, each with the account its rent goes back to.
pub fn close_spent(program: &Program, pairs: &[(Pubkey, Pubkey)]) -> Instruction {
    let metas: Vec<AccountMeta> = pairs
        .iter()
        .flat_map(|(record, receiver)| {
            [
                AccountMeta::new(*record, false),
                AccountMeta::new(*receiver, false),
            ]
        })
        .collect();
    let mut builder = CloseSpentBuilder::new();
    builder.add_remaining_accounts(&metas);
    program.target(builder.instruction())
}
