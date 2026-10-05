//! The one place a receiving wallet decides whether a bond ticket covers a liability, and which
//! attester keys it believes. `verify_payment` calls [`accept`] for every lock a payment names and
//! nothing else decides coverage.
use curve25519_dalek::edwards::CompressedEdwardsY;

use crate::{
    attest::{Revocation, MAX_REGISTRY_AGE},
    lock::TICKET_TTL_MAX,
    slash::{covers, payment_limit},
    verify::Liability,
    BondTicket, Owner, ProtocolError, Result, CHALLENGE, GRACE,
};

/// What a receiving wallet knows about one attester it trusts, as of its last read of the registry.
/// The wallet builds it from its trust list (a pinned or chosen `id` and `authority`) and the
/// registry entry; only attesters whose entry is `Active` become `active`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Attester {
    pub id: u16,
    /// Signs revocations of this attester's keys.
    pub authority: [u8; 32],
    /// Tickets of this attester name this mint, and its stake is in it.
    pub mint: [u8; 32],
    /// Stake in the registry at `synced_at`.
    pub stake: u64,
    /// The key that signs new tickets.
    pub key: [u8; 32],
    /// The key before the last rotation; all zeros if none.
    pub prev_key: [u8; 32],
    /// The previous key is still believed before this time; zero after a compromise.
    pub prev_trusted_until: u32,
    /// Keys the authority revoked, newest first. A revoked key is never believed again.
    pub revoked: [[u8; 32]; 2],
    /// When the registry entry was read.
    pub synced_at: u32,
    pub active: bool,
    /// What this wallet has accepted on this attester's word and not yet seen settled. The wallet
    /// keeps it across payments; `accept` refuses what would take it past a quarter of the stake.
    pub relied: u64,
}

impl Attester {
    pub fn new(
        id: u16,
        authority: [u8; 32],
        mint: [u8; 32],
        stake: u64,
        key: [u8; 32],
        synced_at: u32,
    ) -> Self {
        Self {
            id,
            authority,
            mint,
            stake,
            key,
            prev_key: [0; 32],
            prev_trusted_until: 0,
            revoked: [[0; 32]; 2],
            synced_at,
            active: true,
            relied: 0,
        }
    }

    /// Records `amount` accepted on this attester's word.
    pub fn rely(&mut self, amount: u64) {
        self.relied = self.relied.saturating_add(amount);
    }

    /// Records that `amount` of what was relied on has settled or expired.
    pub fn release(&mut self, amount: u64) {
        self.relied = self.relied.saturating_sub(amount);
    }

    /// Applies a revocation signed by this attester's authority. Idempotent.
    pub fn apply_revocation(
        &mut self,
        revoke_domain: &[u8; 32],
        revocation: &Revocation,
    ) -> Result<()> {
        if revocation.attester != self.id {
            return Err(ProtocolError::Signer);
        }
        let message = revocation.signed_message(revoke_domain);
        if !verify_ed25519(&self.authority, &message, &revocation.signature) {
            return Err(ProtocolError::Signature);
        }
        if !self.revoked.contains(&revocation.key) {
            self.revoked = [revocation.key, self.revoked[0]];
        }
        Ok(())
    }

    fn believed(&self, key: &[u8; 32]) -> bool {
        *key != [0; 32] && !self.revoked.contains(key)
    }

    /// The keys whose tickets are believed at `now`: the current one, and the previous one while
    /// its overlap lasts, unless revoked.
    pub fn signing_keys(&self, now: u32) -> [Option<[u8; 32]>; 2] {
        [
            self.believed(&self.key).then_some(self.key),
            (now < self.prev_trusted_until && self.believed(&self.prev_key))
                .then_some(self.prev_key),
        ]
    }

    /// Whether the registry entry is recent enough to be believed.
    pub fn fresh(&self, now: u32) -> bool {
        now.saturating_sub(self.synced_at) <= MAX_REGISTRY_AGE
    }
}

/// Why a ticket was refused. Every refusal is `ProtocolError::Ticket` to the protocol's callers;
/// the wallet shows the reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TicketError {
    /// More tickets than the payment can use, or two for one lock.
    Count,
    /// No ticket for the lock.
    Missing,
    /// The ticket is for another mint than the note.
    Mint,
    /// The lock does not outlast the note's conflict window by a second.
    LockTooShort,
    /// `valid_until` has passed.
    Stale,
    /// `valid_until` is more than `TICKET_TTL_MAX` away.
    TooLong,
    /// The bond does not cover the amount.
    Bond,
    /// The ticket's backing is below what the issue needs.
    Backing,
    /// No trusted attester has that id.
    UnknownAttester,
    /// The attester is leaving, slashed or gone.
    Inactive,
    /// The wallet's copy of the registry entry is older than `MAX_REGISTRY_AGE`.
    RegistryStale,
    /// The ticket's mint is not the attester's stake mint.
    AttesterMint,
    /// The attester's stake does not cover the amount.
    AttesterStake,
    /// The wallet already relies on this attester for as much as its stake allows in all.
    AttesterCap,
    /// The signing key is not one the wallet believes.
    UnknownKey,
    /// The signature does not verify.
    Signature,
}

/// What a liability needs from its ticket.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Need<'a> {
    pub mint: &'a [u8; 32],
    /// The amount the lock is liable for: the issue's, or the consumed output's.
    pub amount: u64,
    /// The cumulative end of the issue, for the issuer's ticket.
    pub backing: Option<u64>,
    /// Expiry of the note or consumed output.
    pub expiry: u32,
}

/// A canonical encoding of a point in the prime-order subgroup, other than the identity.
pub(crate) fn prime_order(bytes: &[u8; 32]) -> bool {
    CompressedEdwardsY(*bytes)
        .decompress()
        .is_some_and(|point| {
            point.compress().to_bytes() == *bytes
                && point.is_torsion_free()
                && !point.is_small_order()
        })
}

/// Ed25519 as every verifier here checks it: the strict equation, with the key and `R` canonical,
/// torsion-free and not small-order, so Rust, TypeScript and the program's precompile agree.
pub(crate) fn verify_ed25519(key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
    let Ok(verifying) = ed25519_dalek::VerifyingKey::from_bytes(key) else {
        return false;
    };
    let signature = ed25519_dalek::Signature::from_bytes(signature);
    prime_order(key)
        && prime_order(signature.r_bytes())
        && verifying.verify_strict(message, &signature).is_ok()
}

/// A payment carries at most one ticket per message and at most one per lock, so a sender cannot
/// make the receiver check more signatures than the chain needs.
pub(crate) fn check_count(
    spends: usize,
    tickets: &[BondTicket],
) -> core::result::Result<(), TicketError> {
    if tickets.len() > spends + 1 {
        return Err(TicketError::Count);
    }
    for (i, a) in tickets.iter().enumerate() {
        if tickets[i + 1..]
            .iter()
            .any(|b| b.device == a.device && b.lock_seq == a.lock_seq)
        {
            return Err(TicketError::Count);
        }
    }
    Ok(())
}

/// Decides whether the ticket for `(device, lock_seq)` covers `need` at `now`, in the order that
/// puts the signature last because it is the expensive check. The ticket must name the note's mint,
/// outlast its conflict window by a second (a claim needs `now < lock_until`), be valid now and for
/// at most `TICKET_TTL_MAX`, have a bond that `covers` the amount and a backing that reaches the
/// issue's end, come from a trusted attester whose registry entry is recent, whose stake is in the
/// same mint and `covers` the amount too, whose stake also covers everything the wallet already
/// relies on it for, and be signed by a key the wallet believes.
pub fn accept(
    now: u32,
    ticket_domain: &[u8; 32],
    attesters: &[Attester],
    tickets: &[BondTicket],
    device: &Owner,
    lock_seq: u32,
    need: &Need,
) -> core::result::Result<Liability, TicketError> {
    let ticket = tickets
        .iter()
        .find(|t| Owner::Device(t.device) == *device && t.lock_seq == lock_seq)
        .ok_or(TicketError::Missing)?;
    if ticket.mint != *need.mint {
        return Err(TicketError::Mint);
    }
    let settled_by = u64::from(need.expiry) + u64::from(GRACE) + u64::from(CHALLENGE);
    if u64::from(ticket.lock_until) <= settled_by {
        return Err(TicketError::LockTooShort);
    }
    if now > ticket.valid_until {
        return Err(TicketError::Stale);
    }
    if ticket.valid_until - now > TICKET_TTL_MAX {
        return Err(TicketError::TooLong);
    }
    if !covers(ticket.bond, need.amount) {
        return Err(TicketError::Bond);
    }
    if need.backing.is_some_and(|backing| ticket.backing < backing) {
        return Err(TicketError::Backing);
    }
    let attester = attesters
        .iter()
        .find(|a| a.id == ticket.attester)
        .ok_or(TicketError::UnknownAttester)?;
    if !attester.active {
        return Err(TicketError::Inactive);
    }
    if !attester.fresh(now) {
        return Err(TicketError::RegistryStale);
    }
    if attester.mint != ticket.mint {
        return Err(TicketError::AttesterMint);
    }
    if !covers(attester.stake, need.amount) {
        return Err(TicketError::AttesterStake);
    }
    if attester.relied.saturating_add(need.amount) > payment_limit(attester.stake) {
        return Err(TicketError::AttesterCap);
    }
    let keys = attester.signing_keys(now);
    if keys.iter().all(Option::is_none) {
        return Err(TicketError::UnknownKey);
    }
    let message = ticket.signed_message(ticket_domain);
    if !keys
        .iter()
        .flatten()
        .any(|key| verify_ed25519(key, &message, &ticket.signature))
    {
        return Err(TicketError::Signature);
    }
    Ok(Liability {
        device: ticket.device,
        lock_seq,
        bond: ticket.bond,
        attester: ticket.attester,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signer as _;
    use proptest::prelude::*;

    const NOW: u32 = 1_800_000_000;
    const DOMAIN: [u8; 32] = [10; 32];
    const REVOKE: [u8; 32] = [12; 32];
    const MINT: [u8; 32] = [3; 32];
    const EXPIRY: u32 = NOW + 3 * 3600;
    /// A day of validity, or half of the shortest  of a profile.
    const LIFE: u32 = if TICKET_TTL_MAX < 86_400 {
        TICKET_TTL_MAX / 2
    } else {
        86_400
    };
    const SYNC_AGE: u32 = MAX_REGISTRY_AGE / 2;
    const LOCK_UNTIL: u32 = EXPIRY + GRACE + CHALLENGE + 1;

    fn signing(seed: u8) -> ed25519_dalek::SigningKey {
        ed25519_dalek::SigningKey::from_bytes(&[seed; 32])
    }

    fn device() -> [u8; 33] {
        let mut key = [7; 33];
        key[0] = 2;
        key
    }

    fn ticket(bond: u64, valid_until: u32) -> BondTicket {
        let mut ticket = BondTicket {
            device: device(),
            mint: MINT,
            lock_seq: 0,
            bond,
            backing: 10_000,
            lock_until: LOCK_UNTIL,
            valid_until,
            attester: 1,
            signature: [0; 64],
        };
        ticket.signature = signing(11).sign(&ticket.signed_message(&DOMAIN)).to_bytes();
        ticket
    }

    fn attester() -> Attester {
        Attester::new(
            1,
            signing(13).verifying_key().to_bytes(),
            MINT,
            1_000,
            signing(11).verifying_key().to_bytes(),
            NOW - SYNC_AGE,
        )
    }

    fn need() -> Need<'static> {
        Need {
            mint: &MINT,
            amount: 100,
            backing: Some(5_000),
            expiry: EXPIRY,
        }
    }

    fn run(
        attesters: &[Attester],
        tickets: &[BondTicket],
        need: &Need,
    ) -> core::result::Result<Liability, TicketError> {
        accept(
            NOW,
            &DOMAIN,
            attesters,
            tickets,
            &Owner::Device(device()),
            0,
            need,
        )
    }

    #[test]
    fn a_covering_fresh_ticket_from_a_trusted_attester_is_accepted() {
        let t = ticket(400, NOW + LIFE);
        let liability = run(&[attester()], &[t], &need()).unwrap();
        assert_eq!(
            (liability.device, liability.lock_seq, liability.bond),
            (device(), 0, 400)
        );
    }

    #[test]
    fn each_refusal_has_its_own_reason_in_this_order() {
        let good = ticket(400, NOW + LIFE);
        let ok = attester();
        let cases: [(TicketError, BondTicket, Attester, Need); 13] = [
            (
                TicketError::Mint,
                good,
                ok,
                Need {
                    mint: &[4; 32],
                    ..need()
                },
            ),
            (
                TicketError::LockTooShort,
                good,
                ok,
                Need {
                    expiry: EXPIRY + 1,
                    ..need()
                },
            ),
            (TicketError::Stale, ticket(400, NOW - 1), ok, need()),
            (
                TicketError::TooLong,
                ticket(400, NOW + TICKET_TTL_MAX + 1),
                ok,
                need(),
            ),
            (TicketError::Bond, ticket(399, NOW + LIFE), ok, need()),
            (
                TicketError::Backing,
                good,
                ok,
                Need {
                    backing: Some(10_001),
                    ..need()
                },
            ),
            (
                TicketError::Inactive,
                good,
                Attester {
                    active: false,
                    ..ok
                },
                need(),
            ),
            (
                TicketError::RegistryStale,
                good,
                Attester {
                    synced_at: NOW - MAX_REGISTRY_AGE - 1,
                    ..ok
                },
                need(),
            ),
            (
                TicketError::AttesterMint,
                good,
                Attester {
                    mint: [4; 32],
                    ..ok
                },
                need(),
            ),
            (
                TicketError::AttesterStake,
                good,
                Attester { stake: 399, ..ok },
                need(),
            ),
            (
                TicketError::AttesterCap,
                good,
                Attester { relied: 151, ..ok },
                need(),
            ),
            (
                TicketError::UnknownKey,
                good,
                Attester {
                    revoked: [ok.key, [0; 32]],
                    ..ok
                },
                need(),
            ),
            (
                TicketError::Signature,
                BondTicket { bond: 401, ..good },
                ok,
                need(),
            ),
        ];
        for (expected, ticket, attester, need) in cases {
            assert_eq!(
                run(&[attester], &[ticket], &need),
                Err(expected),
                "{expected:?}"
            );
        }
        assert_eq!(
            run(&[], &[good], &need()),
            Err(TicketError::UnknownAttester)
        );
        assert_eq!(run(&[ok], &[], &need()), Err(TicketError::Missing));
        let other = BondTicket {
            attester: 2,
            ..good
        };
        assert_eq!(
            run(&[ok], &[other], &need()),
            Err(TicketError::UnknownAttester)
        );
    }

    #[test]
    fn the_boundaries_are_exact() {
        let ok = attester();
        let n = need();
        assert!(run(&[ok], &[ticket(400, NOW)], &n).is_ok());
        assert!(run(&[ok], &[ticket(400, NOW + TICKET_TTL_MAX)], &n).is_ok());
        assert!(run(
            &[Attester {
                synced_at: NOW - MAX_REGISTRY_AGE,
                ..ok
            }],
            &[ticket(400, NOW + 1)],
            &n
        )
        .is_ok());
        assert!(run(
            &[Attester { stake: 400, ..ok }],
            &[ticket(400, NOW + 1)],
            &n
        )
        .is_ok());
        assert!(run(
            &[ok],
            &[ticket(400, NOW + 1)],
            &Need {
                expiry: EXPIRY - 1,
                ..n
            }
        )
        .is_ok());
    }

    #[test]
    fn the_previous_key_is_believed_only_during_its_overlap_and_never_after_a_compromise() {
        let t = ticket(400, NOW + LIFE);
        let rotated = Attester {
            key: signing(21).verifying_key().to_bytes(),
            prev_key: signing(11).verifying_key().to_bytes(),
            prev_trusted_until: NOW + 1,
            ..attester()
        };
        assert!(run(&[rotated], &[t], &need()).is_ok());
        assert_eq!(
            run(
                &[Attester {
                    prev_trusted_until: NOW,
                    ..rotated
                }],
                &[t],
                &need()
            ),
            Err(TicketError::Signature)
        );
        assert_eq!(
            run(
                &[Attester {
                    prev_trusted_until: 0,
                    ..rotated
                }],
                &[t],
                &need()
            ),
            Err(TicketError::Signature)
        );
    }

    #[test]
    fn a_revocation_signed_by_the_authority_removes_a_key_for_ever() {
        let mut entry = attester();
        let mut revocation = Revocation {
            attester: 1,
            key: entry.key,
            signature: [0; 64],
        };
        revocation.signature = signing(13)
            .sign(&revocation.signed_message(&REVOKE))
            .to_bytes();
        let t = ticket(400, NOW + LIFE);
        assert!(run(&[entry], &[t], &need()).is_ok());
        entry.apply_revocation(&REVOKE, &revocation).unwrap();
        assert_eq!(run(&[entry], &[t], &need()), Err(TicketError::UnknownKey));
        entry.apply_revocation(&REVOKE, &revocation).unwrap();
        assert_eq!(entry.revoked, [revocation.key, [0; 32]]);
        // Another authority, another attester or another domain cannot revoke it.
        let mut fresh = attester();
        let other_attester = Revocation {
            attester: 2,
            ..revocation
        };
        assert_eq!(
            fresh.apply_revocation(&REVOKE, &other_attester),
            Err(ProtocolError::Signer)
        );
        assert_eq!(
            fresh.apply_revocation(&[0; 32], &revocation),
            Err(ProtocolError::Signature)
        );
        let forged = Revocation {
            signature: signing(14)
                .sign(&revocation.signed_message(&REVOKE))
                .to_bytes(),
            ..revocation
        };
        assert_eq!(
            fresh.apply_revocation(&REVOKE, &forged),
            Err(ProtocolError::Signature)
        );
        assert_eq!(fresh.revoked, [[0; 32]; 2]);
    }

    #[test]
    fn two_tickets_for_one_lock_or_too_many_tickets_are_refused() {
        let t = ticket(400, NOW + LIFE);
        assert_eq!(check_count(0, &[t]), Ok(()));
        assert_eq!(
            check_count(0, &[t, BondTicket { lock_seq: 1, ..t }]),
            Err(TicketError::Count)
        );
        assert_eq!(check_count(1, &[t, t]), Err(TicketError::Count));
    }

    #[test]
    fn a_thousand_phantom_payments_of_a_quarter_of_the_stake_stop_at_the_first() {
        let entry = &mut attester();
        let quarter = payment_limit(entry.stake);
        let ticket = ticket(4 * quarter, NOW + LIFE);
        let mut accepted = 0;
        for _ in 0..1_000 {
            let need = Need {
                amount: quarter,
                ..need()
            };
            match run(&[*entry], &[ticket], &need) {
                Ok(_) => {
                    entry.rely(quarter);
                    accepted += 1;
                }
                Err(error) => assert_eq!(error, TicketError::AttesterCap),
            }
        }
        assert_eq!(accepted, 1);
        assert_eq!(entry.relied, quarter);
    }

    #[test]
    fn the_cap_is_exact_and_an_amount_above_it_alone_is_a_stake_refusal() {
        let ticket = ticket(4_000, NOW + LIFE);
        let at = |relied: u64, amount: u64| {
            let entry = Attester {
                stake: 1_000,
                relied,
                ..attester()
            };
            run(&[entry], &[ticket], &Need { amount, ..need() })
        };
        assert!(at(0, 250).is_ok());
        assert!(at(150, 100).is_ok());
        assert_eq!(at(150, 101), Err(TicketError::AttesterCap));
        assert_eq!(at(250, 1), Err(TicketError::AttesterCap));
        assert_eq!(at(0, 251), Err(TicketError::AttesterStake));
        assert_eq!(at(u64::MAX, 1), Err(TicketError::AttesterCap));
    }

    #[test]
    fn relying_and_releasing_never_wrap() {
        let mut entry = attester();
        entry.rely(u64::MAX);
        entry.rely(5);
        assert_eq!(entry.relied, u64::MAX);
        entry.release(u64::MAX);
        entry.release(7);
        assert_eq!(entry.relied, 0);
    }

    proptest! {
        #[test]
        fn acceptance_implies_both_coverages_and_a_recent_registry(
            bond in 0u64..2_000, stake in 0u64..2_000, amount in 1u64..600, age in 0u32..2 * MAX_REGISTRY_AGE,
            relied in 0u64..700,
        ) {
            let t = ticket(bond, NOW + LIFE);
            let entry = Attester { stake, relied, synced_at: NOW - age, ..attester() };
            let result = run(&[entry], &[t], &Need { amount, ..need() });
            let expected = covers(bond, amount)
                && covers(stake, amount)
                && relied + amount <= payment_limit(stake)
                && age <= MAX_REGISTRY_AGE;
            prop_assert_eq!(result.is_ok(), expected);
        }

        #[test]
        fn what_a_wallet_relies_on_one_attester_never_exceeds_a_quarter_of_its_stake(
            stake in 0u64..100_000, amounts in proptest::collection::vec(1u64..30_000, 0..60),
        ) {
            let mut entry = Attester { stake, ..attester() };
            for amount in amounts {
                let t = ticket(amount.saturating_mul(4), NOW + LIFE);
                if run(&[entry], &[t], &Need { amount, ..need() }).is_ok() {
                    entry.rely(amount);
                }
                prop_assert!(entry.relied <= payment_limit(stake));
            }
        }

        #[test]
        fn a_ticket_never_outlives_the_ttl_from_now_or_the_clock(
            until in any::<u32>(),
        ) {
            let t = ticket(400, until);
            let fresh = until >= NOW && until - NOW <= TICKET_TTL_MAX;
            let accepted = run(&[attester()], &[t], &need()).is_ok();
            prop_assert_eq!(accepted, fresh);
        }

        #[test]
        fn flipping_any_bit_of_the_signed_body_refuses_the_ticket(bit in 0usize..97 * 8) {
            let mut wire = ticket(400, NOW + LIFE).encode();
            wire[bit / 8] ^= 1 << (bit % 8);
            // A flip may break the header or the key: those are refusals too.
            if let Ok(t) = BondTicket::decode(&wire) {
                prop_assert!(run(&[attester()], &[t], &need()).is_err());
            }
        }

        #[test]
        fn a_revoked_key_is_never_believed_whatever_the_overlap(
            until in any::<u32>(), now in any::<u32>(),
        ) {
            let mut entry = attester();
            entry.prev_key = entry.key;
            entry.prev_trusted_until = until;
            entry.revoked = [entry.key, [0; 32]];
            prop_assert_eq!(entry.signing_keys(now), [None, None]);
        }
    }
}
