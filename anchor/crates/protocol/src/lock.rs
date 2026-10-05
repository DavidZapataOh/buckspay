//! Windows of the lock lifecycle. Two profiles: the production windows, and `short-windows` (a
//! separate build with its own program id, never deployed under the production one's).
use crate::{CHALLENGE, GRACE};

/// The windows of the lifecycle in seconds. Both profiles are values, so a service that sponsors
/// one of them can know its windows without being built for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Windows {
    pub grace: u32,
    pub challenge: u32,
    pub claim_window: u32,
    pub min_note_life: u32,
    pub release_delay: u32,
    pub rotation_delay: u32,
}

impl Windows {
    pub const PRODUCTION: Self = Self {
        grace: 7 * 24 * 60 * 60,
        challenge: 7 * 24 * 60 * 60,
        claim_window: 7 * 24 * 60 * 60,
        min_note_life: 24 * 60 * 60,
        release_delay: 14 * 24 * 60 * 60,
        rotation_delay: 7 * 24 * 60 * 60,
    };

    pub const SHORT: Self = Self {
        grace: 60,
        challenge: 60,
        claim_window: 60,
        min_note_life: 60,
        release_delay: 60,
        rotation_delay: 60,
    };

    /// `lock_until` must be at least this far from now: one note, from issue to the end of the
    /// challenge.
    pub const fn min_lock(&self) -> u32 {
        self.grace + self.challenge + self.min_note_life
    }

    /// `Lock` and `Ledger` can be closed this long after `lock_until`.
    pub const fn record_ttl(&self) -> u32 {
        self.claim_window + self.challenge
    }
}

#[cfg(not(feature = "short-windows"))]
mod windows {
    use super::Windows;
    pub const CLAIM_WINDOW: u32 = Windows::PRODUCTION.claim_window;
    pub const MIN_NOTE_LIFE: u32 = Windows::PRODUCTION.min_note_life;
    pub const RELEASE_DELAY: u32 = Windows::PRODUCTION.release_delay;
    pub const ROTATION_DELAY: u32 = Windows::PRODUCTION.rotation_delay;
}
#[cfg(feature = "short-windows")]
mod windows {
    use super::Windows;
    pub const CLAIM_WINDOW: u32 = Windows::SHORT.claim_window;
    pub const MIN_NOTE_LIFE: u32 = Windows::SHORT.min_note_life;
    pub const RELEASE_DELAY: u32 = Windows::SHORT.release_delay;
    pub const ROTATION_DELAY: u32 = Windows::SHORT.rotation_delay;
}
pub use windows::{CLAIM_WINDOW, MIN_NOTE_LIFE, RELEASE_DELAY, ROTATION_DELAY};

/// `lock_until` must be at least this far from now: one note, from issue to the end of the challenge.
pub const MIN_LOCK: u32 = GRACE + CHALLENGE + MIN_NOTE_LIFE;
/// `Lock` and `Ledger` can be closed this long after `lock_until`.
pub const RECORD_TTL: u32 = CLAIM_WINDOW + CHALLENGE;
pub const MAX_LOCK: u32 = 366 * 24 * 60 * 60;
pub const MAX_SPONSOR_FEE_DIVISOR: u64 = 4;

// Every inequality the settlement, report and ticket logic relies on, checked when the crate
// compiles in both profiles: a violation is a build error, not a test failure.
const _: () = {
    assert!(RECORD_TTL >= CHALLENGE);
    assert!(RECORD_TTL - CHALLENGE == CLAIM_WINDOW);
    assert!(MIN_LOCK >= GRACE + CHALLENGE + MIN_NOTE_LIFE);
    assert!(MIN_LOCK < MAX_LOCK);
    assert!(CLAIM_WINDOW > 0 && RELEASE_DELAY > 0 && ROTATION_DELAY > 0 && MIN_NOTE_LIFE > 0);
    assert!(CHALLENGE > 0 && GRACE > 0);
    assert!(MAX_SPONSOR_FEE_DIVISOR >= 2);
    assert!(CLAIM_WINDOW + RELEASE_DELAY > CLAIM_WINDOW);
    assert!(RECORD_TTL >= CLAIM_WINDOW);
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(not(feature = "short-windows"))]
    fn production_values() {
        assert_eq!(
            (GRACE, CHALLENGE, CLAIM_WINDOW),
            (604_800, 604_800, 604_800)
        );
        assert_eq!((MIN_LOCK, RECORD_TTL), (1_296_000, 1_209_600));
        assert_eq!(
            (RELEASE_DELAY, ROTATION_DELAY, MAX_LOCK),
            (1_209_600, 604_800, 31_622_400)
        );
    }

    #[test]
    #[cfg(feature = "short-windows")]
    fn short_values_keep_every_relation() {
        assert_eq!(
            (GRACE, CHALLENGE, CLAIM_WINDOW, MIN_NOTE_LIFE),
            (60, 60, 60, 60)
        );
        assert_eq!((MIN_LOCK, RECORD_TTL), (180, 120));
        assert_eq!(core::hint::black_box(RECORD_TTL) - CHALLENGE, CLAIM_WINDOW);
    }

    #[test]
    fn the_active_constants_are_the_windows_of_their_profile() {
        let active = if cfg!(feature = "short-windows") {
            Windows::SHORT
        } else {
            Windows::PRODUCTION
        };
        assert_eq!(
            active,
            Windows {
                grace: GRACE,
                challenge: CHALLENGE,
                claim_window: CLAIM_WINDOW,
                min_note_life: MIN_NOTE_LIFE,
                release_delay: RELEASE_DELAY,
                rotation_delay: ROTATION_DELAY,
            }
        );
        assert_eq!(
            (active.min_lock(), active.record_ttl()),
            (MIN_LOCK, RECORD_TTL)
        );
    }

    #[test]
    fn the_relations_hold_at_run_time_too() {
        use core::hint::black_box;
        assert_eq!(
            black_box(RECORD_TTL).checked_sub(CHALLENGE),
            Some(CLAIM_WINDOW)
        );
        assert!(black_box(MIN_LOCK) > GRACE + CHALLENGE);
        assert!(
            u64::from(u32::MAX) + u64::from(RECORD_TTL + RELEASE_DELAY + CLAIM_WINDOW) < u64::MAX
        );
        assert!(u64::from(u32::MAX)
            .checked_add(u64::from(black_box(MAX_LOCK)))
            .is_some());
    }
}
