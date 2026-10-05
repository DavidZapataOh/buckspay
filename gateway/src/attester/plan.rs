//! What an attester signs, decided from chain data alone. The reader hands the accounts over as a
//! [`ChainView`]; [`plan`] decides whether and what to vouch for, and only a [`Plan`] can be signed,
//! so nothing but facts read from the chain ever carries the key.
use buckspay_protocol::{
    BondTicket,
    attest::LockRecord,
    lock::{MIN_LOCK, TICKET_TTL_MAX},
};
use ed25519_dalek::{Signer as _, SigningKey};

/// How much earlier than `TICKET_TTL_MAX` a ticket expires at most, so a receiver whose clock is a
/// little behind the attester's does not refuse it as valid for too long.
pub const ISSUE_MARGIN: u32 = 3_600;

/// The accounts of one lock as read at `finalized`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChainView {
    pub lock: Option<LockRecord>,
    pub bond_free: u64,
    pub bond_slashed: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Policy {
    pub attester: u16,
    pub mint: [u8; 32],
    /// Ticket lifetimes the attester grants; a request names one.
    pub lifetimes: [u32; 2],
    /// `valid_until` is rounded down to a multiple of this, so equal requests get equal bytes.
    pub quantum: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// No `Lock` at the seeds: never created, or closed.
    LockAbsent,
    /// The lock is on another mint than the attester's.
    WrongMint,
    /// A claim has taken part of the bond.
    Impaired,
    /// The lock ends too soon for any note to rely on it.
    LockTooShort,
    /// The requested lifetime is not one the attester grants.
    LifetimeNotGranted,
}

impl Refusal {
    pub fn reason(self) -> &'static str {
        match self {
            Self::LockAbsent => "lock_absent",
            Self::WrongMint => "wrong_mint",
            Self::Impaired => "impaired",
            Self::LockTooShort => "lock_too_short",
            Self::LifetimeNotGranted => "lifetime_not_granted",
        }
    }
}

/// A ticket that may be signed: built only by [`plan`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[must_use]
pub struct Plan(BondTicket);

impl Plan {
    pub fn valid_until(&self) -> u32 {
        self.0.valid_until
    }
}

/// Decides what the attester vouches for at `now` for the lock `(device, lock_seq)`: exactly its
/// record, for the requested lifetime rounded down, and only if the lock is whole and long enough.
pub fn plan(
    policy: &Policy,
    device: [u8; 33],
    lock_seq: u32,
    chain: &ChainView,
    now: u32,
    lifetime: u32,
) -> Result<Plan, Refusal> {
    if !policy.lifetimes.contains(&lifetime) {
        return Err(Refusal::LifetimeNotGranted);
    }
    let lock = chain.lock.ok_or(Refusal::LockAbsent)?;
    if lock.mint != policy.mint {
        return Err(Refusal::WrongMint);
    }
    if chain.bond_slashed != 0 || chain.bond_free != lock.bond {
        return Err(Refusal::Impaired);
    }
    if u64::from(lock.lock_until) < u64::from(now) + u64::from(MIN_LOCK) {
        return Err(Refusal::LockTooShort);
    }
    let until =
        u64::from(now) + u64::from(lifetime.min(TICKET_TTL_MAX.saturating_sub(ISSUE_MARGIN)));
    let quantum = u64::from(policy.quantum.max(1));
    let valid_until =
        u32::try_from(until / quantum * quantum).map_err(|_| Refusal::LockTooShort)?;
    Ok(Plan(BondTicket {
        device,
        mint: lock.mint,
        lock_seq,
        bond: lock.bond,
        backing: lock.backing,
        lock_until: lock.lock_until,
        valid_until,
        attester: policy.attester,
        signature: [0; 64],
    }))
}

/// Holds the signing key and signs plans under the ticket domain.
pub struct Issuer {
    key: SigningKey,
    domain: [u8; 32],
}

impl Issuer {
    pub fn new(seed: [u8; 32], ticket_domain: [u8; 32]) -> Self {
        Self {
            key: SigningKey::from_bytes(&seed),
            domain: ticket_domain,
        }
    }

    pub fn public(&self) -> [u8; 32] {
        self.key.verifying_key().to_bytes()
    }

    pub fn sign(&self, plan: Plan) -> BondTicket {
        let mut ticket = plan.0;
        ticket.signature = self
            .key
            .sign(&ticket.signed_message(&self.domain))
            .to_bytes();
        ticket
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buckspay_protocol::{
        Owner,
        ticket::{Attester, Need, accept},
    };
    use proptest::prelude::*;

    const NOW: u32 = 1_900_000_000;
    const MINT: [u8; 32] = [3; 32];
    const DOMAIN: [u8; 32] = [10; 32];
    const DAY: u32 = 86_400;

    fn policy() -> Policy {
        Policy {
            attester: 1,
            mint: MINT,
            lifetimes: [DAY, 71 * 3600],
            quantum: 3_600,
        }
    }

    fn device() -> [u8; 33] {
        let mut key = [7; 33];
        key[0] = 2;
        key
    }

    fn chain() -> ChainView {
        ChainView {
            lock: Some(LockRecord {
                mint: MINT,
                bond: 400,
                backing: 10_000,
                lock_until: NOW + 90 * DAY,
            }),
            bond_free: 400,
            bond_slashed: 0,
        }
    }

    #[test]
    fn it_vouches_for_exactly_the_record_and_signs_a_ticket_receivers_accept() {
        let issuer = Issuer::new([11; 32], DOMAIN);
        let ticket = issuer.sign(plan(&policy(), device(), 0, &chain(), NOW, DAY).unwrap());
        let lock = chain().lock.unwrap();
        assert_eq!(
            (
                ticket.mint,
                ticket.bond,
                ticket.backing,
                ticket.lock_until,
                ticket.attester
            ),
            (lock.mint, lock.bond, lock.backing, lock.lock_until, 1)
        );
        assert!(ticket.valid_until <= NOW + DAY && ticket.valid_until > NOW + DAY - 3_600);
        assert_eq!(ticket.valid_until % 3_600, 0);
        let registry = Attester::new(1, [0; 32], MINT, 1_000, issuer.public(), NOW);
        let need = Need {
            mint: &MINT,
            amount: 100,
            backing: Some(5_000),
            expiry: NOW + 3 * 3_600,
        };
        let liability = accept(
            NOW,
            &DOMAIN,
            &[registry],
            &[ticket],
            &Owner::Device(device()),
            0,
            &need,
        );
        assert_eq!(liability.unwrap().bond, 400);
    }

    #[test]
    fn it_refuses_what_the_chain_does_not_support() {
        let p = policy();
        let ok = chain();
        let lock = ok.lock.unwrap();
        let with = |lock: LockRecord| ChainView {
            lock: Some(lock),
            ..ok
        };
        let cases = [
            (ChainView { lock: None, ..ok }, DAY, Refusal::LockAbsent),
            (
                with(LockRecord {
                    mint: [4; 32],
                    ..lock
                }),
                DAY,
                Refusal::WrongMint,
            ),
            (
                ChainView {
                    bond_slashed: 1,
                    ..ok
                },
                DAY,
                Refusal::Impaired,
            ),
            (
                ChainView {
                    bond_free: 399,
                    ..ok
                },
                DAY,
                Refusal::Impaired,
            ),
            (
                with(LockRecord {
                    lock_until: NOW + MIN_LOCK - 1,
                    ..lock
                }),
                DAY,
                Refusal::LockTooShort,
            ),
            (ok, DAY + 1, Refusal::LifetimeNotGranted),
            (ok, 3 * DAY, Refusal::LifetimeNotGranted),
        ];
        for (view, lifetime, expected) in cases {
            assert_eq!(
                plan(&p, device(), 0, &view, NOW, lifetime).unwrap_err(),
                expected
            );
        }
        let exactly = with(LockRecord {
            lock_until: NOW + MIN_LOCK,
            ..lock
        });
        assert!(plan(&p, device(), 0, &exactly, NOW, DAY).is_ok());
    }

    #[test]
    fn equal_requests_in_one_quantum_get_equal_bytes() {
        let issuer = Issuer::new([11; 32], DOMAIN);
        let at = |now| issuer.sign(plan(&policy(), device(), 0, &chain(), now, DAY).unwrap());
        let start = NOW - NOW % 3_600;
        assert_eq!(at(start).encode(), at(start + 3_599).encode());
        assert_ne!(at(start).encode(), at(start + 3_600).encode());
    }

    proptest! {
        #[test]
        fn a_ticket_is_always_inside_the_receivers_freshness_rule(
            now in 1_000_000_000u32..2_000_000_000, long in any::<bool>(), quantum in 1u32..7_200,
        ) {
            let p = Policy { quantum, ..policy() };
            let lifetime = if long { p.lifetimes[1] } else { p.lifetimes[0] };
            let view = ChainView {
                lock: Some(LockRecord { lock_until: now + 200 * DAY, ..chain().lock.unwrap() }),
                ..chain()
            };
            let t = plan(&p, device(), 0, &view, now, lifetime).unwrap().valid_until();
            prop_assert!(t <= now + TICKET_TTL_MAX - ISSUE_MARGIN);
            prop_assert!(t + quantum > now + lifetime.min(TICKET_TTL_MAX - ISSUE_MARGIN));
        }
    }
}
