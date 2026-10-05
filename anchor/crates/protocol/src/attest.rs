//! What an attester vouches for, when that is provably false, and the notice that withdraws one of
//! its keys. Everything here is a pure function: the program, the gateway and the app call the same
//! code.
use crate::{
    hash::{self, purpose},
    kind,
    lock::RECORD_TTL,
    message::array,
    BondTicket, ProtocolError, Result, CHALLENGE, GRACE, VERSION,
};

pub use crate::lock::{MAX_REGISTRY_AGE, TICKET_TTL_MAX};

/// The longest note a receiver accepts by default, counted from the moment it accepts it. A note
/// outlives the attester's exit only if it was accepted late and expires late, so this bound is
/// part of what [`EXIT_DELAY`] covers.
pub const MAX_NOTE_LIFE: u32 = TICKET_TTL_MAX;

/// How long an attester's stake stays at risk after it asks to leave, and how long a rotated-out
/// key stays accountable. A receiver may still trust the attester for [`MAX_REGISTRY_AGE`], a
/// ticket it signs in that time is valid for [`TICKET_TTL_MAX`], the note accepted on it lasts at
/// most [`MAX_NOTE_LIFE`], the loss shows when the note is settled within `GRACE` of its expiry, and
/// a claim may follow for `CHALLENGE` more.
pub const EXIT_DELAY: u32 = MAX_REGISTRY_AGE + TICKET_TTL_MAX + MAX_NOTE_LIFE + GRACE + CHALLENGE;

/// The smallest stake, in whole tokens of the stake mint.
pub const MIN_STAKE_TOKENS: u64 = 100;

const _: () = {
    assert!(EXIT_DELAY > MAX_REGISTRY_AGE + TICKET_TTL_MAX);
    assert!(crate::lock::MIN_NOTE_LIFE <= MAX_NOTE_LIFE);
    assert!(RECORD_TTL >= CHALLENGE);
};

/// A lock's four fields as the `Lock` account records them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LockRecord {
    pub mint: [u8; 32],
    pub bond: u64,
    pub backing: u64,
    pub lock_until: u32,
}

/// Whether a ticket contradicts the chain, and how.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Falsity {
    /// The chain does not contradict the ticket.
    NotFalse,
    /// The `Lock` exists and a field differs.
    Mismatch,
    /// No such lock ever existed: its sequence number is at or above the device's counter, or the
    /// device is not registered.
    NeverExisted,
    /// The lock was created and closed, and the ticket claims a `lock_until` that `close_lock`
    /// could not have allowed.
    ClosedClaim,
}

/// `close_lock` opens at `lock_until + record_ttl`, so a sequence number below the device's counter
/// whose `Lock` account is gone had a `lock_until` of at most `now - record_ttl`: a ticket that
/// claims more is false without the record.
pub fn closed_lock_ticket_is_false(ticket_lock_until: u32, now: u64, record_ttl: u64) -> bool {
    u64::from(ticket_lock_until).saturating_add(record_ttl) > now
}

/// Decides, from accounts alone, whether `ticket` is false. `lock` is the `Lock` at the ticket's
/// seeds if the account exists, `next_lock_seq` the `Device` counter if the device exists. The
/// ticket's `valid_until` is not in any account, so no ticket is false because of it.
pub fn falsity(
    ticket: &BondTicket,
    lock: Option<&LockRecord>,
    next_lock_seq: Option<u32>,
    now: u64,
) -> Falsity {
    if let Some(lock) = lock {
        let same = lock.mint == ticket.mint
            && lock.bond == ticket.bond
            && lock.backing == ticket.backing
            && lock.lock_until == ticket.lock_until;
        return if same {
            Falsity::NotFalse
        } else {
            Falsity::Mismatch
        };
    }
    match next_lock_seq {
        Some(next) if ticket.lock_seq < next => {
            if closed_lock_ticket_is_false(ticket.lock_until, now, u64::from(RECORD_TTL)) {
                Falsity::ClosedClaim
            } else {
                Falsity::NotFalse
            }
        }
        _ => Falsity::NeverExisted,
    }
}

/// The attester's authority withdraws one of its keys: `ver ‖ kind ‖ attester:u16 ‖ key[32]` and the
/// authority's Ed25519 signature over `DOMAIN(revoke) ‖ body`. Phones carry it over the mesh like a
/// fraud proof; it only ever removes trust, so replaying it does no harm.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Revocation {
    pub attester: u16,
    pub key: [u8; 32],
    pub signature: [u8; 64],
}

impl Revocation {
    pub const BODY_LEN: usize = 36;
    pub const WIRE_LEN: usize = Self::BODY_LEN + 64;

    fn body(&self) -> [u8; Self::BODY_LEN] {
        let mut out = [0; Self::BODY_LEN];
        out[0] = VERSION;
        out[1] = kind::REVOCATION;
        out[2..4].copy_from_slice(&self.attester.to_le_bytes());
        out[4..].copy_from_slice(&self.key);
        out
    }

    pub fn encode(&self) -> [u8; Self::WIRE_LEN] {
        let mut out = [0; Self::WIRE_LEN];
        out[..Self::BODY_LEN].copy_from_slice(&self.body());
        out[Self::BODY_LEN..].copy_from_slice(&self.signature);
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() != Self::WIRE_LEN {
            return Err(ProtocolError::Length);
        }
        if bytes[0] != VERSION {
            return Err(ProtocolError::Version);
        }
        if bytes[1] != kind::REVOCATION {
            return Err(ProtocolError::Kind);
        }
        Ok(Self {
            attester: u16::from_le_bytes(array(bytes, 2)),
            key: array(bytes, 4),
            signature: array(bytes, Self::BODY_LEN),
        })
    }

    /// The bytes the authority signs with Ed25519.
    pub fn signed_message(&self, revoke_domain: &[u8; 32]) -> [u8; 32 + Self::BODY_LEN] {
        let mut out = [0; 32 + Self::BODY_LEN];
        out[..32].copy_from_slice(revoke_domain);
        out[32..].copy_from_slice(&self.body());
        out
    }
}

/// The domain of revocations on a cluster and program.
pub fn revoke_domain(genesis_hash: &[u8; 32], program_id: &[u8; 32]) -> [u8; 32] {
    hash::domain(purpose::REVOKE, genesis_hash, program_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn ticket(lock_seq: u32, lock_until: u32) -> BondTicket {
        BondTicket {
            device: {
                let mut key = [7; 33];
                key[0] = 2;
                key
            },
            mint: [3; 32],
            lock_seq,
            bond: 400,
            backing: 1_000,
            lock_until,
            valid_until: 1_800_086_400,
            attester: 1,
            signature: [0; 64],
        }
    }

    fn record(t: &BondTicket) -> LockRecord {
        LockRecord {
            mint: t.mint,
            bond: t.bond,
            backing: t.backing,
            lock_until: t.lock_until,
        }
    }

    #[test]
    fn the_exit_delay_covers_acceptance_note_life_settlement_and_claim() {
        use core::hint::black_box;
        assert_eq!(
            black_box(EXIT_DELAY),
            MAX_REGISTRY_AGE + TICKET_TTL_MAX + MAX_NOTE_LIFE + GRACE + CHALLENGE
        );
        let expected = if cfg!(feature = "short-windows") {
            540
        } else {
            27 * 24 * 60 * 60
        };
        assert_eq!(black_box(EXIT_DELAY), expected);
    }

    #[test]
    fn a_ticket_equal_to_its_lock_is_not_false() {
        let t = ticket(0, 1_900_000_000);
        assert_eq!(
            falsity(&t, Some(&record(&t)), Some(1), 1_800_000_000),
            Falsity::NotFalse
        );
    }

    #[test]
    fn every_field_of_the_record_makes_a_ticket_false() {
        let t = ticket(0, 1_900_000_000);
        let lock = record(&t);
        for wrong in [
            LockRecord {
                mint: [4; 32],
                ..lock
            },
            LockRecord {
                bond: lock.bond - 1,
                ..lock
            },
            LockRecord {
                backing: lock.backing + 1,
                ..lock
            },
            LockRecord {
                lock_until: lock.lock_until + 1,
                ..lock
            },
        ] {
            assert_eq!(
                falsity(&t, Some(&wrong), Some(1), 1_800_000_000),
                Falsity::Mismatch
            );
        }
    }

    #[test]
    fn a_sequence_number_at_or_above_the_counter_never_existed() {
        let t = ticket(5, 1_900_000_000);
        for next in [None, Some(0), Some(5)] {
            assert_eq!(
                falsity(&t, None, next, 1_800_000_000),
                Falsity::NeverExisted
            );
        }
        assert_eq!(
            falsity(&t, None, Some(6), 1_800_000_000),
            Falsity::ClosedClaim
        );
    }

    #[test]
    fn the_closed_lock_boundary_is_exact() {
        let t = ticket(0, 1_000);
        let at = 1_000 + u64::from(RECORD_TTL);
        assert_eq!(falsity(&t, None, Some(1), at), Falsity::NotFalse);
        assert_eq!(falsity(&t, None, Some(1), at - 1), Falsity::ClosedClaim);
    }

    #[test]
    fn a_revocation_round_trips_and_signs_domain_then_body() {
        let revocation = Revocation {
            attester: 7,
            key: [9; 32],
            signature: [5; 64],
        };
        let wire = revocation.encode();
        assert_eq!(wire.len(), 100);
        assert_eq!(Revocation::decode(&wire), Ok(revocation));
        let message = revocation.signed_message(&[1; 32]);
        assert_eq!(message.len(), 68);
        assert_eq!(&message[..32], &[1; 32]);
        assert_eq!(&message[32..], &wire[..36]);
        let mut padded = [0u8; 128];
        padded[..100].copy_from_slice(&wire);
        for len in [0, 35, 99, 101] {
            assert_eq!(
                Revocation::decode(&padded[..len]),
                Err(ProtocolError::Length)
            );
        }
    }

    proptest! {
        #[test]
        fn a_ticket_that_matches_a_really_closed_lock_is_never_provably_false(
            lock_until in any::<u32>(), delay in 0u64..=100_000_000, later in 0u64..=100_000_000,
        ) {
            // `close_lock` succeeds only at or after lock_until + RECORD_TTL, and a report comes after it.
            let closed_at = u64::from(lock_until) + u64::from(RECORD_TTL) + delay;
            let reported_at = closed_at + later;
            let t = ticket(0, lock_until);
            prop_assert_eq!(falsity(&t, None, Some(1), reported_at), Falsity::NotFalse);
        }

        #[test]
        fn an_honest_ticket_is_never_false_whatever_the_state_of_its_lock(
            lock_until in any::<u32>(), seq in 0u32..1_000, extra in 0u32..1_000, now in any::<u64>(),
        ) {
            // The lock exists: the ticket is its record. The lock is closed: `now` is past the close.
            let t = ticket(seq, lock_until);
            prop_assert_eq!(falsity(&t, Some(&record(&t)), Some(seq + 1 + extra), now), Falsity::NotFalse);
            let after_close = now.max(u64::from(lock_until) + u64::from(RECORD_TTL));
            prop_assert_eq!(falsity(&t, None, Some(seq + 1 + extra), after_close), Falsity::NotFalse);
        }

        #[test]
        fn a_ticket_for_a_lock_that_exists_is_false_exactly_when_a_field_differs(
            bond in any::<u64>(), backing in any::<u64>(), lock_until in any::<u32>(),
            d_bond in any::<bool>(), d_backing in any::<bool>(), d_until in any::<bool>(),
        ) {
            let mut t = ticket(0, lock_until);
            t.bond = bond;
            t.backing = backing;
            let mut lock = record(&t);
            if d_bond { lock.bond = lock.bond.wrapping_add(1); }
            if d_backing { lock.backing = lock.backing.wrapping_add(1); }
            if d_until { lock.lock_until = lock.lock_until.wrapping_add(1); }
            let expected = if d_bond || d_backing || d_until { Falsity::Mismatch } else { Falsity::NotFalse };
            prop_assert_eq!(falsity(&t, Some(&lock), Some(1), 0), expected);
        }

        #[test]
        fn a_useful_ticket_over_a_closed_lock_is_provably_false(
            now in 0u64..=u64::from(u32::MAX), ahead in 0u32..=31_622_400,
        ) {
            // A receiver accepts a ticket only if its lock_until is not in the past.
            let lock_until = u32::try_from(now + u64::from(ahead)).unwrap_or(u32::MAX);
            prop_assume!(u64::from(lock_until) >= now);
            let t = ticket(0, lock_until);
            prop_assert_eq!(falsity(&t, None, Some(1), now), Falsity::ClosedClaim);
        }
    }
}
