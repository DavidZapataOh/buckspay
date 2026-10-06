//! Private settlement: the configuration, the per-mint and per-lock draw windows and the proof
//! buffer.
use anchor_lang::prelude::*;

use crate::error::BuckspayError;

pub const ZK_CONFIG_SEED: &[u8] = b"zk-config";
pub const ZK_MINT_SEED: &[u8] = b"zk-mint";
pub const ZK_DRAWS_SEED: &[u8] = b"zk-draws";
pub const PROOF_BUFFER_SEED: &[u8] = b"proof-buffer";

/// The length of the draw windows.
pub const ZK_CAP_WINDOW_SECS: i64 = 86_400;
/// How long a proof buffer stays before its payer may close it unsettled.
pub const STALE_BUFFER_SECS: u32 = 3_600;

/// One message on the wire: the content of its body, the output the next message consumes, the
/// state it leaves and its compressed proof.
pub const WIRE_LEN: usize = 32 + 1 + 32 + buckspay_zk_verify::PROOF_COMPRESSED;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct WireMessage {
    pub content: [u8; 32],
    pub next_bit: u8,
    pub s_out: [u8; 32],
    pub proof: [u8; buckspay_zk_verify::PROOF_COMPRESSED],
}

impl WireMessage {
    /// Reads one message of a proof buffer.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let bytes: &[u8; WIRE_LEN] = bytes
            .try_into()
            .map_err(|_| error!(BuckspayError::BufferLength))?;
        let (content, rest) = bytes.split_at(32);
        let (next_bit, rest) = rest.split_at(1);
        let (s_out, proof) = rest.split_at(32);
        Ok(Self {
            content: content
                .try_into()
                .map_err(|_| error!(BuckspayError::BufferLength))?,
            next_bit: next_bit[0],
            s_out: s_out
                .try_into()
                .map_err(|_| error!(BuckspayError::BufferLength))?,
            proof: proof
                .try_into()
                .map_err(|_| error!(BuckspayError::BufferLength))?,
        })
    }
}

/// The hashes of the key files the app trusts: verifying key, proving key (binary and dump) and
/// constraint system.
#[derive(
    AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Default, Debug, PartialEq, Eq,
)]
pub struct KeyHashes {
    pub vk: [u8; 32],
    pub pk: [u8; 32],
    pub dump: [u8; 32],
    pub ccs: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct ZkConfig {
    pub admin: Pubkey,
    pub pauser: Pubkey,
    pub paused: bool,
    pub current: KeyHashes,
    pub previous: KeyHashes,
    /// When the key before `current` was replaced; zero when no previous key is accepted.
    pub rotated_at: i64,
    pub bump: u8,
}

/// A rolling draw window: two buckets, the current one and the one before it.
#[derive(
    AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Default, Debug, PartialEq, Eq,
)]
pub struct Window {
    pub start: i64,
    pub cur: u64,
    pub prev: u64,
}

impl Window {
    /// Admits `amount` if the draws of the current bucket plus the share of the previous one that
    /// still overlaps the last `len` seconds stay within `cap`.
    pub fn admit(&mut self, now: i64, amount: u64, cap: u64, len: i64) -> Result<()> {
        let mut elapsed = now.saturating_sub(self.start).max(0);
        if elapsed >= 2 * len {
            *self = Window {
                start: now,
                ..Window::default()
            };
            elapsed = 0;
        } else if elapsed >= len {
            self.prev = self.cur;
            self.cur = 0;
            self.start += len;
            elapsed -= len;
        }
        let carried = u128::from(self.prev) * u128::try_from(len - elapsed).unwrap_or(0)
            / u128::try_from(len).unwrap_or(1);
        let total = u128::from(self.cur) + carried + u128::from(amount);
        require!(total <= u128::from(cap), BuckspayError::ZkCapExceeded);
        self.cur += amount;
        Ok(())
    }
}

/// Per-mint policy and draws; the account is absent until the admin enables the mint.
#[account]
#[derive(InitSpace)]
pub struct ZkMint {
    pub global_cap: u64,
    pub lock_cap: u64,
    /// Withheld from a settlement for every `Spent` record it creates.
    pub record_fee: u64,
    /// The token account of the mint that receives the fees.
    pub fee_account: Pubkey,
    pub window: Window,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ZkLockDraws {
    pub window: Window,
    pub bump: u8,
}

/// Messages written by a settler ahead of the settlement transaction that reads them. The
/// messages follow this header in the account, `len` bytes of them.
#[account]
#[derive(InitSpace)]
pub struct ProofBuffer {
    pub payer: Pubkey,
    pub nonce: u64,
    pub len: u32,
    /// The bytes written so far; writes may not leave a gap.
    pub written: u32,
    pub created_at: u32,
    pub bump: u8,
}

pub const PROOF_BUFFER_HEADER: usize = 8 + ProofBuffer::INIT_SPACE;

/// Whether keys made by a throwaway ceremony may be pinned on a cluster: never on mainnet.
pub fn keys_permitted(test_keys: bool, genesis_hash: &[u8; 32]) -> bool {
    !test_keys || *genesis_hash != buckspay_protocol::cluster::MAINNET_GENESIS_HASH
}

/// The per-mint account of `mint`, or `MintNotEnabled` while the admin has not created it.
pub fn read_mint(info: &AccountInfo, mint: &Pubkey) -> Result<ZkMint> {
    require_keys_eq!(*info.owner, crate::ID, BuckspayError::MintNotEnabled);
    let value: ZkMint = read(info)?;
    let address =
        Pubkey::create_program_address(&[ZK_MINT_SEED, mint.as_ref(), &[value.bump]], &crate::ID)
            .map_err(|_| error!(BuckspayError::RecordAccounts))?;
    require_keys_eq!(info.key(), address, BuckspayError::RecordAccounts);
    Ok(value)
}

pub fn read<T: AccountDeserialize>(info: &AccountInfo) -> Result<T> {
    let data = info.try_borrow_data()?;
    T::try_deserialize(&mut &data[..])
}

pub fn write<T: AccountSerialize>(info: &AccountInfo, value: &T) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    value.try_serialize(&mut &mut data[..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use buckspay_protocol::cluster::{DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH};
    use proptest::prelude::*;

    #[test]
    fn test_keys_are_refused_on_mainnet_only() {
        assert!(!keys_permitted(true, &MAINNET_GENESIS_HASH));
        assert!(keys_permitted(true, &DEVNET_GENESIS_HASH));
        assert!(keys_permitted(false, &MAINNET_GENESIS_HASH));
        assert!(keys_permitted(false, &DEVNET_GENESIS_HASH));
    }

    proptest! {
        #[test]
        fn window_admits_at_most_two_caps_in_any_interval(
            steps in prop::collection::vec((0i64..30_000, 0u64..60), 1..300)
        ) {
            const LEN: i64 = 86_400;
            const CAP: u64 = 100;
            let (mut w, mut now, mut admitted) = (Window::default(), 0i64, Vec::new());
            for (dt, amount) in steps {
                now += dt;
                if w.admit(now, amount, CAP, LEN).is_ok() {
                    admitted.push((now, amount));
                }
                prop_assert!(w.cur <= CAP);
            }
            for &(start, _) in &admitted {
                let sum: u64 = admitted
                    .iter()
                    .filter(|(t, _)| *t >= start && *t < start + LEN)
                    .map(|(_, a)| a)
                    .sum();
                prop_assert!(sum <= 2 * CAP, "{sum} admitted in one window");
            }
        }
    }
}
