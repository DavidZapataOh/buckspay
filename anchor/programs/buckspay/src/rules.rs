//! Pure rules shared by the instructions and by the programs that build on locks.

pub use buckspay_protocol::attest::closed_lock_ticket_is_false;

/// `10^decimals`, or `u64::MAX` when it does not fit: a mint made by an attacker can declare up to
/// 255 decimals.
pub fn one_whole_token(decimals: u8) -> u64 {
    10u64.checked_pow(u32::from(decimals)).unwrap_or(u64::MAX)
}

/// The largest `sponsor_fee` the program accepts for lock funds of `funds`: a quarter of them and
/// at most one whole token.
pub fn sponsor_fee_cap(funds: u64, decimals: u8) -> u64 {
    (funds / buckspay_protocol::lock::MAX_SPONSOR_FEE_DIVISOR).min(one_whole_token(decimals))
}
