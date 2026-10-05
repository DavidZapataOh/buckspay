//! What the gateway reads from accounts, without a token or sysvar crate: the base layout of a
//! token account (the same in both token programs), the clock sysvar and associated token
//! addresses.
use solana_pubkey::Pubkey;

pub const TOKEN_PROGRAM: Pubkey =
    Pubkey::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM: Pubkey =
    Pubkey::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ASSOCIATED_TOKEN_PROGRAM: Pubkey =
    Pubkey::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const CLOCK_SYSVAR: Pubkey =
    Pubkey::from_str_const("SysvarC1ock11111111111111111111111111111111");

/// The signature fee of the clusters, in lamports.
pub const SIGNATURE_FEE: u64 = 5_000;

const TOKEN_ACCOUNT_LEN: usize = 165;
const MINT_DECIMALS_OFFSET: usize = 44;
const FROZEN: u8 = 2;

/// The fields of a token account the gateway checks before it sponsors a lock.
#[derive(Debug, PartialEq, Eq)]
pub struct TokenAccount {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub frozen: bool,
}

impl TokenAccount {
    /// `None` unless `data` is at least the 165 bytes of a token account's base layout.
    pub fn parse(data: &[u8]) -> Option<Self> {
        if data.len() < TOKEN_ACCOUNT_LEN {
            return None;
        }
        Some(Self {
            mint: Pubkey::new_from_array(data[..32].try_into().ok()?),
            owner: Pubkey::new_from_array(data[32..64].try_into().ok()?),
            amount: u64::from_le_bytes(data[64..72].try_into().ok()?),
            frozen: data[108] == FROZEN,
        })
    }
}

/// The decimals of a mint account.
pub fn mint_decimals(data: &[u8]) -> Option<u8> {
    data.get(MINT_DECIMALS_OFFSET).copied()
}

/// `unix_timestamp` of the clock sysvar: after the slot, the epoch start timestamp, the epoch and
/// the leader schedule epoch.
pub fn clock_unix(data: &[u8]) -> Option<i64> {
    Some(i64::from_le_bytes(data.get(32..40)?.try_into().ok()?))
}

/// The associated token account of `wallet` for `mint` under `token_program`.
pub fn associated_token_address(wallet: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[wallet.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM,
    )
    .0
}

/// What the program's accounts cost to keep: read from the cluster, never constants.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rents {
    pub device: u64,
    pub rotation: u64,
    pub lock: u64,
    pub ledger: u64,
    pub escrow: u64,
    /// A settlement record.
    pub record: u64,
    /// A claim.
    pub claim: u64,
}

impl Rents {
    /// Rent lent for as long as a lock is open.
    pub fn float(&self) -> u64 {
        self.lock + self.ledger + self.escrow
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_base_layout_of_a_token_account() {
        let (mint, owner) = (Pubkey::new_unique(), Pubkey::new_unique());
        let mut data = vec![0; 165];
        data[..32].copy_from_slice(mint.as_ref());
        data[32..64].copy_from_slice(owner.as_ref());
        data[64..72].copy_from_slice(&1_234u64.to_le_bytes());
        data[108] = 1;
        assert_eq!(
            TokenAccount::parse(&data),
            Some(TokenAccount {
                mint,
                owner,
                amount: 1_234,
                frozen: false
            })
        );
        data[108] = 2;
        assert!(TokenAccount::parse(&data).unwrap().frozen);
        assert_eq!(TokenAccount::parse(&data[..164]), None);
    }

    #[test]
    fn reads_the_unix_timestamp_of_the_clock() {
        let mut data = vec![0; 40];
        data[32..].copy_from_slice(&1_800_000_000i64.to_le_bytes());
        assert_eq!(clock_unix(&data), Some(1_800_000_000));
        assert_eq!(clock_unix(&data[..39]), None);
    }

    #[test]
    fn derives_the_associated_token_address() {
        let wallet = Pubkey::from_str_const("11111111111111111111111111111112");
        let usdc = Pubkey::from_str_const("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
        let address = associated_token_address(&wallet, &usdc, &TOKEN_PROGRAM);
        assert_ne!(
            address,
            associated_token_address(&wallet, &usdc, &TOKEN_2022_PROGRAM)
        );
    }
}
