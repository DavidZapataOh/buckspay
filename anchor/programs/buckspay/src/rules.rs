//! Pure rules shared by the instructions and by the programs that build on locks.

/// `lock_until + RECORD_TTL` is the earliest second `close_lock` can succeed, so a lock that has
/// been closed (its sequence number is below `Device.next_lock_seq` and its `Lock` account is gone)
/// had a `lock_until` of at most `now - record_ttl`. A ticket that claims more is false without
/// needing the record.
pub fn closed_lock_ticket_is_false(ticket_lock_until: u32, now: u64, record_ttl: u64) -> bool {
    u64::from(ticket_lock_until).saturating_add(record_ttl) > now
}

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
