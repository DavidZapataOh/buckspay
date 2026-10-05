use anchor_lang::prelude::*;
use buckspay_protocol::{
    cluster,
    device::{device_binding_envelope, device_rotation_envelope},
    hash::{domain, purpose},
};

pub mod accounting;
pub mod burn;
mod clock;
pub mod error;
mod filing;
mod instructions;
mod mint;
pub mod payout;
mod pda;
pub mod records;
pub mod refund;
pub mod rules;
mod settlement;
mod spent;
pub mod state;
mod verification;

pub use error::BuckspayError;
pub use instructions::*;
pub use settlement::Link;
pub use state::{
    Claim, Device, Ledger, Lock, Rotation, Spent, CLAIM_SEED, DEVICE_SEED, ESCROW_SEED,
    LEDGER_SEED, LOCK_SEED, ROTATION_SEED, SPENT_SEED,
};

#[cfg(not(any(feature = "devnet", feature = "mainnet")))]
compile_error!("build for one cluster: `--features devnet` or `--features mainnet`");
#[cfg(all(feature = "devnet", feature = "mainnet"))]
compile_error!("enable exactly one of the `devnet` and `mainnet` features");

#[cfg(all(feature = "short-windows", feature = "mainnet"))]
compile_error!("the short-windows profile exists on devnet only");
#[cfg(all(feature = "short-windows", not(feature = "devnet")))]
compile_error!("the short-windows profile needs the devnet feature");

#[cfg(all(feature = "devnet", not(feature = "short-windows")))]
declare_id!("zkJoXgVrQ8kvJGvnAYXGaF8KgT9pUKKExXF4zoF2eTM");
#[cfg(feature = "short-windows")]
declare_id!("JA82vFUvNM3vvRbYbiU3xx748qEchaJ3Htr8FKFEMFKT");
#[cfg(feature = "devnet")]
pub const GENESIS_HASH: [u8; 32] = cluster::DEVNET_GENESIS_HASH;

#[cfg(feature = "mainnet")]
compile_error!("the mainnet program id is declared with the mainnet program keypair");
#[cfg(feature = "mainnet")]
pub const GENESIS_HASH: [u8; 32] = cluster::MAINNET_GENESIS_HASH;

#[program]
pub mod buckspay {
    use super::*;

    pub fn register_device(ctx: Context<RegisterDevice>, key: [u8; 33]) -> Result<()> {
        ctx.accounts.process(&ctx.bumps, key)
    }

    /// Grows a `Device` that predates the counters to the current layout. Devnet builds only.
    #[cfg(feature = "devnet")]
    pub fn migrate_device(ctx: Context<MigrateDevice>, key: [u8; 33]) -> Result<()> {
        let _ = key;
        ctx.accounts.process(&ctx.bumps)
    }

    pub fn create_lock(ctx: Context<CreateLock>, args: CreateLockArgs) -> Result<()> {
        ctx.accounts.process(&ctx.bumps, args)
    }

    pub fn withdraw_lock(ctx: Context<WithdrawLock>, key: [u8; 33], lock_seq: u32) -> Result<()> {
        let _ = (key, lock_seq);
        ctx.accounts.process()
    }

    pub fn release_lock(ctx: Context<ReleaseLock>, key: [u8; 33], lock_seq: u32) -> Result<()> {
        let _ = (key, lock_seq);
        ctx.accounts.process()
    }

    pub fn close_lock(ctx: Context<CloseLock>, key: [u8; 33], lock_seq: u32) -> Result<()> {
        let _ = (key, lock_seq);
        ctx.accounts.process(&ctx.bumps)
    }

    pub fn request_wallet_rotation(
        ctx: Context<RequestWalletRotation>,
        key: [u8; 33],
    ) -> Result<()> {
        ctx.accounts.process(&ctx.bumps, key)
    }

    pub fn cancel_wallet_rotation(ctx: Context<CancelWalletRotation>, key: [u8; 33]) -> Result<()> {
        let _ = key;
        ctx.accounts.process()
    }

    pub fn apply_wallet_rotation(ctx: Context<ApplyWalletRotation>, key: [u8; 33]) -> Result<()> {
        let _ = key;
        ctx.accounts.process()
    }

    /// Settles the chain `issue` plus `spends` in clear: pays the account its last spend names.
    pub fn settle_note<'info>(
        ctx: Context<'info, SettleNote<'info>>,
        issue: [u8; settlement::ISSUE_BODY_LEN],
        spends: Vec<Link>,
    ) -> Result<()> {
        ctx.accounts
            .process(&issue, &spends, ctx.remaining_accounts)
    }

    /// Takes back an output nobody settled in time, for the wallet its owner's key is bound to.
    pub fn reclaim_output<'info>(
        ctx: Context<'info, ReclaimOutput<'info>>,
        owner: [u8; 33],
        issue: [u8; settlement::ISSUE_BODY_LEN],
        spends: Vec<Link>,
        which: u8,
        deadline: u32,
    ) -> Result<()> {
        ctx.accounts.process(
            &owner,
            &issue,
            &spends,
            which,
            deadline,
            ctx.remaining_accounts,
        )
    }

    /// Records the consumed outputs of a chain without paying, so a later settlement of the chain
    /// needs the signature of its last message only.
    pub fn record_prefix<'info>(
        ctx: Context<'info, RecordPrefix<'info>>,
        issue: [u8; settlement::ISSUE_BODY_LEN],
        spends: Vec<Link>,
    ) -> Result<()> {
        ctx.accounts
            .process(&issue, &spends, ctx.remaining_accounts)
    }

    /// Closes the records whose retention has passed and returns their rent to whoever paid it.
    pub fn close_spent<'info>(ctx: Context<'info, CloseSpent>) -> Result<()> {
        CloseSpent::process(ctx.remaining_accounts)
    }

    /// Burns what the loss of the branch that lost the contested output proves.
    pub fn claim_lost_spend(ctx: Context<ClaimLostSpend>, lost: LostSpend) -> Result<()> {
        ctx.accounts.process(&lost)
    }

    /// Burns what the loss of a chain the issuer's backing can no longer pay proves.
    pub fn claim_unbacked<'info>(
        ctx: Context<'info, ClaimUnbacked<'info>>,
        issue: [u8; settlement::ISSUE_BODY_LEN],
        spends: Vec<Link>,
    ) -> Result<()> {
        ctx.accounts
            .process(&issue, &spends, ctx.remaining_accounts)
    }

    /// Closes claims whose retention has passed.
    pub fn close_records<'info>(ctx: Context<'info, CloseRecords>) -> Result<()> {
        CloseRecords::process(ctx.remaining_accounts)
    }
}

/// The domain of issues and spends on this cluster and program.
pub fn note_domain() -> [u8; 32] {
    domain(purpose::NOTE, &GENESIS_HASH, &ID.to_bytes())
}

/// The domain of reclaims on this cluster and program.
pub fn reclaim_domain() -> [u8; 32] {
    domain(purpose::RECLAIM, &GENESIS_HASH, &ID.to_bytes())
}

/// The message `key` signs to consent to being bound to `wallet` on this cluster and program.
pub fn device_envelope(wallet: &Pubkey, key: &[u8; 33]) -> Result<[u8; 96]> {
    let domain = domain(purpose::DEVICE, &GENESIS_HASH, &ID.to_bytes());
    device_binding_envelope(&domain, &wallet.to_bytes(), key)
        .map_err(|_| error!(BuckspayError::DeviceKey))
}

/// The message `key` signs to consent to moving its binding from `old_wallet` to `new_wallet`,
/// as the `rotations`-th rotation of the device.
pub fn rotation_envelope(
    old_wallet: &Pubkey,
    new_wallet: &Pubkey,
    key: &[u8; 33],
    rotations: u32,
) -> Result<[u8; 96]> {
    let domain = domain(purpose::DEVICE, &GENESIS_HASH, &ID.to_bytes());
    device_rotation_envelope(
        &domain,
        &old_wallet.to_bytes(),
        &new_wallet.to_bytes(),
        key,
        rotations,
    )
    .map_err(|_| error!(BuckspayError::DeviceKey))
}
