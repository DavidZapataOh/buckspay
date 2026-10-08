use anchor_lang::prelude::*;
use buckspay_protocol::{
    cluster,
    device::{device_binding_envelope, device_rotation_envelope},
    hash::{domain, purpose},
    BondTicket,
};

pub mod accounting;
mod attestation;
pub mod burn;
pub mod channel;
mod clock;
pub mod error;
mod filing;
mod instructions;
mod mint;
pub mod netting;
pub mod payout;
mod pda;
pub mod records;
pub mod refund;
pub mod rewards;
pub mod rules;
mod settlement;
mod spent;
pub mod state;
mod verification;
pub mod zk;

pub use channel::{Channel, CHANNEL_CLOSE_DELAY, CHANNEL_SEED, MAX_CHANNELS_PER_TX};
pub use error::BuckspayError;
pub use instructions::*;
pub use netting::{Netting, NETTING_KEEP_SECS, NETTING_SEED};
pub use rewards::{
    scope as reward_scope, LeafAppended, RewardConfig, RewardMint, RewardPolicy, RewardTree,
    CLAIM_KEY_OVERLAP_SECS, MAX_CLAIMS_PER_TX, REWARD_CONFIG_SEED, REWARD_LEDGER_MARKER,
    REWARD_MINT_SEED, REWARD_NULLIFIER_SEED, REWARD_TREE_SEED, ROOT_HISTORY, TREE_DEPTH,
};
pub use settlement::Link;
pub use state::{
    Attester, Claim, Device, Ledger, Lock, Rotation, Spent, ATTESTER_SEED, CLAIM_SEED, DEVICE_SEED,
    ESCROW_SEED, LEDGER_SEED, LOCK_SEED, ROTATION_SEED, SPENT_SEED,
};
pub use zk::{
    KeyHashes, ProofBuffer, Window, WireMessage, ZkConfig, ZkLockDraws, ZkMint, STALE_BUFFER_SECS,
    ZK_CAP_WINDOW_SECS,
};

#[cfg(not(any(feature = "devnet", feature = "mainnet")))]
compile_error!("build for one cluster: `--features devnet` or `--features mainnet`");
#[cfg(all(feature = "devnet", feature = "mainnet"))]
compile_error!("enable exactly one of the `devnet` and `mainnet` features");

#[cfg(all(feature = "zk-test-keys", feature = "mainnet"))]
compile_error!("verifying keys of a throwaway ceremony cannot be built into a mainnet program");

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

    /// Settles a chain by one batch of proofs: pays the account the last message names and
    /// records every consumed output, with no key or signature of the chain on chain.
    #[allow(clippy::too_many_arguments)]
    pub fn settle_chain_proof<'info>(
        ctx: Context<'info, SettleChainProof<'info>>,
        vk_sha256: [u8; 32],
        issuer_key: [u8; 33],
        lock_seq: u32,
        amount: u64,
        cum_end: u64,
        pay_amount: u64,
        expiry: u32,
        messages: Vec<WireMessage>,
    ) -> Result<()> {
        ctx.accounts.process(
            vk_sha256,
            issuer_key,
            lock_seq,
            amount,
            cum_end,
            pay_amount,
            expiry,
            messages,
            ctx.remaining_accounts,
        )
    }

    /// Opens a buffer for the messages of a chain too long for one transaction.
    pub fn open_proof_buffer(ctx: Context<OpenProofBuffer>, nonce: u64, len: u32) -> Result<()> {
        ctx.accounts.process(&ctx.bumps, nonce, len)
    }

    pub fn write_proof_buffer(
        ctx: Context<WriteProofBuffer>,
        offset: u32,
        data: Vec<u8>,
    ) -> Result<()> {
        ctx.accounts.process(offset, &data)
    }

    /// Closes a buffer nobody settled within `STALE_BUFFER_SECS` and returns its rent.
    pub fn close_proof_buffer(ctx: Context<CloseProofBuffer>) -> Result<()> {
        ctx.accounts.process()
    }

    pub fn init_zk_config(
        ctx: Context<InitZkConfig>,
        admin: Pubkey,
        pauser: Pubkey,
        current: KeyHashes,
    ) -> Result<()> {
        ctx.accounts.process(&ctx.bumps, admin, pauser, current)
    }

    /// The pauser may only pause; the admin may do either.
    pub fn set_zk_paused(ctx: Context<ZkAdmin>, paused: bool) -> Result<()> {
        ctx.accounts.set_paused(paused)
    }

    pub fn set_zk_mint(
        ctx: Context<SetZkMint>,
        global_cap: u64,
        lock_cap: u64,
        record_fee: u64,
        fee_account: Pubkey,
    ) -> Result<()> {
        ctx.accounts
            .process(global_cap, lock_cap, record_fee, fee_account)
    }

    pub fn rotate_vk(ctx: Context<ZkAdmin>, next: KeyHashes, keep_previous: bool) -> Result<()> {
        ctx.accounts.rotate_vk(next, keep_previous)
    }

    /// Ends the acceptance of the previous verifying key; the pauser or the admin may call it.
    pub fn revoke_previous_vk(ctx: Context<ZkAdmin>) -> Result<()> {
        ctx.accounts.revoke_previous_vk()
    }

    pub fn set_zk_authorities(ctx: Context<ZkAdmin>, admin: Pubkey, pauser: Pubkey) -> Result<()> {
        ctx.accounts.set_authorities(admin, pauser)
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

    /// Registers an attester with its stake. The authority signs and may be a multisig.
    pub fn register_attester(
        ctx: Context<RegisterAttester>,
        args: RegisterAttesterArgs,
    ) -> Result<()> {
        ctx.accounts.process(&args, &ctx.bumps)
    }

    pub fn top_up_attester(ctx: Context<TopUpAttester>, amount: u64) -> Result<()> {
        ctx.accounts.process(amount)
    }

    /// Replaces the key that signs tickets; the old one stays accountable for `EXIT_DELAY`.
    pub fn rotate_attester_key(
        ctx: Context<ManageAttester>,
        new_key: [u8; 32],
        trust_previous: bool,
    ) -> Result<()> {
        ctx.accounts.rotate_key(new_key, trust_previous)
    }

    pub fn request_attester_exit(ctx: Context<ManageAttester>) -> Result<()> {
        ctx.accounts.request_exit()
    }

    pub fn cancel_attester_exit(ctx: Context<ManageAttester>) -> Result<()> {
        ctx.accounts.cancel_exit()
    }

    pub fn withdraw_attester_stake(ctx: Context<WithdrawAttesterStake>) -> Result<()> {
        ctx.accounts.process()
    }

    /// Settles words of delivery channels into the reward pool: each pays `word_value` out of its
    /// lock, the leaves of what the pool owes are computed here, never taken from the caller.
    pub fn settle_channel<'info>(
        ctx: Context<'info, SettleChannel<'info>>,
        args: SettleChannelArgs,
    ) -> Result<()> {
        ctx.accounts.process(args, ctx.remaining_accounts)
    }

    /// Closes a channel whose words can no longer be settled and returns its rent to its payer.
    pub fn close_channel(ctx: Context<CloseChannel>) -> Result<()> {
        ctx.accounts.process()
    }

    pub fn init_reward_config(
        ctx: Context<InitRewardConfig>,
        admin: Pubkey,
        pauser: Pubkey,
        claim_key: KeyHashes,
    ) -> Result<()> {
        ctx.accounts.process(&ctx.bumps, admin, pauser, claim_key)
    }

    /// Replaces the claim key by the one this program carries. With `keep_previous` the replaced
    /// key stays accepted for a while.
    pub fn rotate_claim_vk(
        ctx: Context<RewardAdmin>,
        next: KeyHashes,
        keep_previous: bool,
    ) -> Result<()> {
        ctx.accounts.rotate_claim_vk(next, keep_previous)
    }

    /// Ends the acceptance of the previous claim key at once; the pauser may call it too.
    pub fn revoke_previous_claim_vk(ctx: Context<RewardAdmin>) -> Result<()> {
        ctx.accounts.revoke_previous_claim_vk()
    }

    pub fn set_reward_authorities(
        ctx: Context<RewardAdmin>,
        admin: Pubkey,
        pauser: Pubkey,
    ) -> Result<()> {
        ctx.accounts.set_authorities(admin, pauser)
    }

    /// Pays the leaves of the reward pool to the recipient the proofs name. Anyone may submit.
    pub fn claim_rewards<'info>(
        ctx: Context<'info, ClaimRewards<'info>>,
        args: ClaimArgs,
    ) -> Result<()> {
        ctx.accounts.process(args, ctx.remaining_accounts)
    }

    /// The pauser may only pause; the admin may do either. Settling words is never paused.
    pub fn set_rewards_paused(ctx: Context<RewardAdmin>, paused: bool) -> Result<()> {
        ctx.accounts.set_paused(paused)
    }

    pub fn init_reward_mint(ctx: Context<InitRewardMint>, policy: RewardPolicy) -> Result<()> {
        ctx.accounts.process(&ctx.bumps, policy)
    }

    pub fn set_reward_policy(
        ctx: Context<SetRewardPolicy>,
        claim_fee: u64,
        fee_account: Pubkey,
        claim_cap: u64,
    ) -> Result<()> {
        ctx.accounts.process(claim_fee, fee_account, claim_cap)
    }

    /// Starts the next epoch's tree once the current one is full. Anyone may call it.
    pub fn rotate_reward_tree(ctx: Context<RotateRewardTree>) -> Result<()> {
        ctx.accounts.process(&ctx.bumps)
    }

    /// Records a circular netting every participant signed and one proof covers.
    pub fn record_netting(
        ctx: Context<RecordNetting>,
        statement: Vec<u8>,
        proof: [u8; 256],
    ) -> Result<()> {
        ctx.accounts.process(&statement, &proof)
    }

    /// Closes a netting record after its keep window and returns the rent to its payer.
    pub fn close_netting(ctx: Context<CloseNetting>) -> Result<()> {
        ctx.accounts.process()
    }

    /// Destroys the whole stake of the attester that signed a ticket the chain contradicts.
    pub fn report_false_ticket(
        ctx: Context<ReportFalseTicket>,
        ticket: [u8; BondTicket::WIRE_LEN],
    ) -> Result<()> {
        ctx.accounts.process(&ticket)
    }
}

/// The domain of issues and spends on this cluster and program.
pub fn note_domain() -> [u8; 32] {
    domain(purpose::NOTE, &GENESIS_HASH, &ID.to_bytes())
}

/// The domain of bond tickets on this cluster and program.
pub fn ticket_domain() -> [u8; 32] {
    domain(purpose::TICKET, &GENESIS_HASH, &ID.to_bytes())
}

/// The domain of delivery-word commitments on this cluster and program.
pub fn payword_domain() -> [u8; 32] {
    domain(purpose::PAYWORD, &GENESIS_HASH, &ID.to_bytes())
}

/// The domain the participants of a netting sign under on this cluster and program.
pub fn netting_domain() -> [u8; 32] {
    domain(purpose::NETTING, &GENESIS_HASH, &ID.to_bytes())
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
