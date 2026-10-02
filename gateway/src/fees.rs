/// The highest compute unit price the app accepts in a sponsored registration, in micro-lamports
/// (`MAX_SPONSORED_PRIORITY_FEE` in the app). The gateway's own cap may only be lower.
pub const APP_MAX_PRIORITY_FEE: u64 = 1_000_000;

/// The compute unit price of a sponsored registration: the 75th percentile (nearest rank) of the
/// prices recently paid to write its accounts, so it lands in a busy slot without paying for the
/// highest outlier, capped at `cap`; 0 without recent fees.
pub fn priority_fee(mut recent: Vec<u64>, cap: u64) -> u64 {
    if recent.is_empty() {
        return 0;
    }
    recent.sort_unstable();
    let rank = (recent.len() * 3).div_ceil(4);
    recent[rank - 1].min(cap)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_75th_percentile_of_recent_fees_under_the_cap() {
        assert_eq!(priority_fee(vec![], 100_000), 0);
        assert_eq!(priority_fee(vec![0; 150], 100_000), 0);
        assert_eq!(priority_fee(vec![40, 10, 30, 20], 100_000), 30);
        assert_eq!(priority_fee((1..=100).collect(), 100_000), 75);
        assert_eq!(
            priority_fee(vec![5_000_000, 2_000_000, 1], 100_000),
            100_000
        );
    }
}
