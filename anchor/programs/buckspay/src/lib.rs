use anchor_lang::prelude::*;
use buckspay_protocol::{
    cluster,
    device::device_binding_envelope,
    hash::{domain, purpose},
};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

#[cfg(not(any(feature = "devnet", feature = "mainnet")))]
compile_error!("build for one cluster: `--features devnet` or `--features mainnet`");
#[cfg(all(feature = "devnet", feature = "mainnet"))]
compile_error!("enable exactly one of the `devnet` and `mainnet` features");

#[cfg(feature = "devnet")]
declare_id!("zkJoXgVrQ8kvJGvnAYXGaF8KgT9pUKKExXF4zoF2eTM");
#[cfg(feature = "devnet")]
pub const GENESIS_HASH: [u8; 32] = cluster::DEVNET_GENESIS_HASH;

#[cfg(feature = "mainnet")]
compile_error!("the mainnet program id is declared with the mainnet program keypair");
#[cfg(feature = "mainnet")]
pub const GENESIS_HASH: [u8; 32] = cluster::MAINNET_GENESIS_HASH;

/// Seed prefix of `Device` accounts. Every account type has its own prefix and no prefix is a
/// prefix of another, so accounts of two types can never share an address.
pub const DEVICE_SEED: &[u8] = b"device";

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

#[program]
pub mod buckspay {
    use super::*;

    pub fn register_device(ctx: Context<RegisterDevice>, key: [u8; 33]) -> Result<()> {
        let wallet = ctx.accounts.wallet.key();
        let expected = device_envelope(&wallet, &key)?;

        // Exactly one secp256r1 verification before this instruction is this binding, wherever it
        // is: wallets may add their own instructions around ours, and verifications of other
        // bindings (another registration in the same transaction) are not this one's.
        let sysvar = ctx.accounts.instructions.to_account_info();
        let current = load_current_index_checked(&sysvar)?;
        let mut matching = 0;
        for index in 0..usize::from(current) {
            let instruction = load_instruction_at_checked(index, &sysvar)?;
            if instruction.program_id == solana_sdk_ids::secp256r1_program::ID
                && is_binding(&instruction.data, &key, &expected)
            {
                matching += 1;
            }
        }
        require!(matching == 1, BuckspayError::DeviceBinding);

        ctx.accounts.device.set_inner(Device {
            wallet,
            bump: ctx.bumps.device,
        });
        Ok(())
    }
}

/// The message `key` signs to consent to being bound to `wallet` on this cluster and program.
pub fn device_envelope(wallet: &Pubkey, key: &[u8; 33]) -> Result<[u8; 96]> {
    let domain = domain(purpose::DEVICE, &GENESIS_HASH, &ID.to_bytes());
    device_binding_envelope(&domain, &wallet.to_bytes(), key)
        .map_err(|_| error!(BuckspayError::DeviceKey))
}

/// Whether `data` is the inline verification of `key` over `message` and nothing else: one
/// signature, every offset inline, exactly the 209 bytes `new_secp256r1_instruction_with_signature`
/// produces.
fn is_binding(data: &[u8], key: &[u8; 33], message: &[u8; 96]) -> bool {
    data.len() == SECP256R1_DATA_LEN
        && data[..KEY_OFFSET] == SECP256R1_HEADER
        && data[KEY_OFFSET..SIGNATURE_OFFSET] == key[..]
        && data[MESSAGE_OFFSET..] == message[..]
}

#[derive(Accounts)]
#[instruction(key: [u8; 33])]
pub struct RegisterDevice<'info> {
    /// The wallet the key is bound to: its signature is the consent, checked against the binding.
    pub wallet: Signer<'info>,
    /// Pays the device account's rent: the wallet itself, or a sponsor.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = Device::DISCRIMINATOR.len() + Device::INIT_SPACE,
        seeds = [DEVICE_SEED, &key[..1], &key[1..]],
        bump,
    )]
    pub device: Account<'info, Device>,
    /// CHECK: the instructions sysvar, pinned by address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// A device key bound to a wallet. The key is in the account's seeds, so it is not stored.
#[account]
#[derive(InitSpace)]
pub struct Device {
    pub wallet: Pubkey,
    pub bump: u8,
}

#[error_code]
pub enum BuckspayError {
    #[msg("Device key is not a compressed P-256 point")]
    DeviceKey,
    #[msg("Missing or malformed secp256r1 verification of the device binding")]
    DeviceBinding,
}
