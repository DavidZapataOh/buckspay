//! The time windows of one output as pure functions of three timestamps, so the program, the
//! gateway and the later plans read the same rules: when a spend of it can be settled, when it can
//! be reclaimed, until when a conflict on it can be reported and when its record may be closed.
use crate::{
    lock::{Windows, CLAIM_WINDOW},
    CHALLENGE,
};

/// The last second (inclusive) at which a spend of an output that expires at `expiry` is settled.
pub const fn settle_deadline(expiry: u32) -> u64 {
    settle_deadline_in(&Windows::ACTIVE, expiry)
}

/// The first second at which the owner of an output that expires at `expiry` can reclaim it, if
/// the lock lasts.
pub const fn reclaim_opens(expiry: u32) -> u64 {
    settle_deadline(expiry) + 1
}

/// The last second (inclusive) at which a conflict on the output is reported, if the lock lasts.
pub const fn report_deadline(expiry: u32) -> u64 {
    settle_deadline(expiry) + CHALLENGE as u64
}

/// The second at which the record of the output may be closed: after the settlement window and
/// the reclaim window (`RECORD_TTL`), and after the claim window of any report on it, whichever
/// ends the lock first.
pub const fn closable_at(expiry: u32, lock_until: u32) -> u64 {
    closable_at_in(&Windows::ACTIVE, expiry, lock_until)
}

/// The end of the last claim window a report on the output can open (reports are refused at or
/// after `lock_until`).
pub const fn claims_end(expiry: u32, lock_until: u32) -> u64 {
    let end = report_deadline(expiry);
    let end = if end < lock_until as u64 {
        end
    } else {
        lock_until as u64
    };
    end + CLAIM_WINDOW as u64
}

/// The second at which the claim of an output whose contested output expires at `expiry` may be
/// closed: after the last claim window of the contested output (`claims_end`) and one
/// `RECORD_TTL` more, so a claim outlives the last second the same loss could be claimed again.
/// It is a function of the contested output and never of how long its lock is chosen to last.
pub const fn claim_closable_at(expiry: u32, lock_until: u32) -> u64 {
    claims_end(expiry, lock_until) + Windows::ACTIVE.record_ttl() as u64
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Settle {
    Open,
    LockEnded,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reclaim {
    TooEarly,
    Open,
    LockEnded,
    Closed,
}

/// Whether a spend of an output with this `expiry` can be settled now.
pub const fn settle(expiry: u32, lock_until: u32, now: u32) -> Settle {
    settle_in(&Windows::ACTIVE, expiry, lock_until, now)
}

/// Whether the owner of an output with this `expiry` can reclaim it now.
pub const fn reclaim(expiry: u32, lock_until: u32, now: u32) -> Reclaim {
    reclaim_in(&Windows::ACTIVE, expiry, lock_until, now)
}

/// The same rules for the windows of either profile, for a service that serves a program built
/// with windows other than the ones this crate was compiled with.
pub const fn settle_deadline_in(windows: &Windows, expiry: u32) -> u64 {
    expiry as u64 + windows.grace as u64
}

pub const fn closable_at_in(windows: &Windows, expiry: u32, lock_until: u32) -> u64 {
    let end = settle_deadline_in(windows, expiry);
    let end = if end < lock_until as u64 {
        end
    } else {
        lock_until as u64
    };
    end + windows.record_ttl() as u64
}

pub const fn settle_in(windows: &Windows, expiry: u32, lock_until: u32, now: u32) -> Settle {
    if now >= lock_until {
        Settle::LockEnded
    } else if now as u64 > settle_deadline_in(windows, expiry) {
        Settle::Closed
    } else {
        Settle::Open
    }
}

pub const fn reclaim_in(windows: &Windows, expiry: u32, lock_until: u32, now: u32) -> Reclaim {
    if now >= lock_until {
        Reclaim::LockEnded
    } else if now as u64 <= settle_deadline_in(windows, expiry) {
        Reclaim::TooEarly
    } else if (now as u64) < closable_at_in(windows, expiry, lock_until) {
        Reclaim::Open
    } else {
        Reclaim::Closed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{lock::RECORD_TTL, GRACE};

    const E: u32 = 1_000_000;

    #[test]
    fn production_boundaries() {
        let lock = E + 100 * 86_400;
        assert_eq!(settle(E, lock, E + GRACE), Settle::Open);
        assert_eq!(settle(E, lock, E + GRACE + 1), Settle::Closed);
        assert_eq!(reclaim(E, lock, E + GRACE), Reclaim::TooEarly);
        assert_eq!(reclaim(E, lock, E + GRACE + 1), Reclaim::Open);
        let close = (E + GRACE + RECORD_TTL) as u64;
        assert_eq!(closable_at(E, lock), close);
        assert_eq!(reclaim(E, lock, close as u32 - 1), Reclaim::Open);
        assert_eq!(reclaim(E, lock, close as u32), Reclaim::Closed);
    }

    #[test]
    fn the_lock_ends_every_window() {
        let lock = E + 5;
        assert_eq!(settle(E, lock, lock - 1), Settle::Open);
        assert_eq!(settle(E, lock, lock), Settle::LockEnded);
        assert_eq!(reclaim(E, lock, lock), Reclaim::LockEnded);
        assert_eq!(
            closable_at(E, lock),
            u64::from(lock) + u64::from(RECORD_TTL)
        );
    }

    #[test]
    fn either_profile_can_be_asked_for_its_windows_by_value() {
        let lock = E + 100 * 86_400;
        for windows in [Windows::PRODUCTION, Windows::SHORT] {
            let grace = u64::from(windows.grace);
            assert_eq!(settle_deadline_in(&windows, E), u64::from(E) + grace);
            assert_eq!(
                closable_at_in(&windows, E, lock),
                u64::from(E) + grace + u64::from(windows.record_ttl())
            );
            let opens = E + windows.grace + 1;
            assert_eq!(settle_in(&windows, E, lock, opens), Settle::Closed);
            assert_eq!(reclaim_in(&windows, E, lock, opens), Reclaim::Open);
            assert_eq!(reclaim_in(&windows, E, lock, opens - 1), Reclaim::TooEarly);
        }
        assert_eq!(settle_deadline_in(&Windows::ACTIVE, E), settle_deadline(E));
        assert_eq!(
            closable_at_in(&Windows::ACTIVE, E, E + 5),
            closable_at(E, E + 5)
        );
    }

    #[test]
    fn a_far_expiry_is_bounded_by_the_lock_not_by_u32() {
        let lock = 1_900_000_000;
        assert_eq!(
            closable_at(u32::MAX, lock),
            u64::from(lock) + u64::from(RECORD_TTL)
        );
        assert_eq!(
            closable_at(0, lock),
            u64::from(GRACE) + u64::from(RECORD_TTL)
        );
    }
}
