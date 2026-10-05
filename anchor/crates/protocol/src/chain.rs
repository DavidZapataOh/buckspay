//! The rules of a chain of messages without any signature check. `verify` adds P-256 verification
//! for off-chain use; the program takes the signatures from the secp256r1 precompile instead.
use crate::{
    caveats::{flags, Caveats, Owner},
    hash::{content, envelope, message_id, output_id},
    lock::EXPIRY_STEP,
    message::{Issue, Outputs, Spend, NO_LOCK},
    ProtocolError, Result,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Output {
    pub id: [u8; 32],
    pub owner: Owner,
    pub amount: u64,
    pub caveats: Caveats,
}

/// The outputs one message creates: output 0 (the payment) and the change of a `Spend2`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Holding {
    pub first: Output,
    pub second: Option<Output>,
}

/// Whether a spend of an output with these caveats is backed without the spender's lock.
pub fn unlocked(input: &Caveats) -> bool {
    input.flags & (flags::DELEGATED | flags::AUTHORITY_ONLY) != 0
}

/// A `Spend1` to a terminal account: a settlement, which nothing spends further.
pub fn settles(spend: &Spend) -> bool {
    matches!(
        spend.outputs,
        Outputs::One {
            owner: Owner::Account(_),
            ..
        }
    )
}

/// An output a device holds can be reclaimed by that device, so the spender's own reclaim of the
/// input it paid with must open after the payee's: a payment to a device expires at least
/// `EXPIRY_STEP` before its input. Outputs to terminal accounts are never reclaimed and are free.
pub fn steps_down(input: &Caveats, owner: &Owner, payment: &Caveats) -> bool {
    matches!(owner, Owner::Account(_))
        || u64::from(payment.expiry) + u64::from(EXPIRY_STEP) <= u64::from(input.expiry)
}

fn check_lock(input: &Caveats, spend: &Spend, payment: &Caveats) -> Result<()> {
    if spend.lock_seq != NO_LOCK {
        return Ok(());
    }
    if !(unlocked(input) || settles(spend)) || payment.flags & flags::DELEGATED != 0 {
        return Err(ProtocolError::Lock);
    }
    Ok(())
}

/// The first output (owner, amount, caveats) and the change of a spend of `input`, if the rules of
/// a hop allow them.
pub type Hop = (Owner, u64, Caveats, Option<(u64, Caveats)>);

pub fn hop(input: &Output, spend: &Spend) -> Result<Hop> {
    let (owner, amount, caveats, change) = match spend.outputs {
        Outputs::One { owner, caveats } => (owner, input.amount, caveats, None),
        Outputs::Two {
            owner0,
            amount0,
            caveats0,
            owner1,
        } => {
            let change = input.caveats.change()?;
            if amount0 >= input.amount {
                return Err(ProtocolError::Amount);
            }
            if owner1 != input.owner {
                return Err(ProtocolError::Change);
            }
            (
                owner0,
                amount0,
                caveats0,
                Some((input.amount - amount0, change)),
            )
        }
    };
    let rules = input.caveats.for_holder(&input.owner);
    if !rules.permits(&caveats) {
        return Err(ProtocolError::Attenuation);
    }
    if !steps_down(&input.caveats, &owner, &caveats) {
        return Err(ProtocolError::ExpiryStep);
    }
    if !rules.admits(&owner) {
        return Err(ProtocolError::Scope);
    }
    check_lock(&rules, spend, &caveats)?;
    Ok((owner, amount, caveats, change))
}

/// The envelope the issuer signs and the output the issue creates.
pub fn issue_signing(domain: &[u8; 32], issue: &Issue) -> Result<([u8; 96], Output)> {
    issue.check()?;
    let env = envelope(domain, &issue.slot()?, &content(&issue.body()));
    let output = Output {
        id: output_id(&message_id(&env), 0),
        owner: issue.owner,
        amount: issue.amount,
        caveats: issue.caveats,
    };
    Ok((env, output))
}

/// The key that must sign a spend of `input` and the envelope it signs.
pub fn spend_signing(
    domain: &[u8; 32],
    input: &Output,
    spend: &Spend,
) -> Result<([u8; 33], [u8; 96])> {
    let Owner::Device(holder) = input.owner else {
        return Err(ProtocolError::Owner);
    };
    spend.check()?;
    Ok((holder, envelope(domain, &input.id, &spend.content())))
}

/// The outputs a spend of `input` creates once its envelope `env` is signed, and the owner of the
/// first one.
pub fn spend_outputs(env: &[u8; 96], input: &Output, spend: &Spend) -> Result<(Holding, Owner)> {
    let (owner, amount, caveats, change) = hop(input, spend)?;
    let id = message_id(env);
    Ok((
        Holding {
            first: Output {
                id: output_id(&id, 0),
                owner,
                amount,
                caveats,
            },
            second: change.map(|(amount, caveats)| Output {
                id: output_id(&id, 1),
                owner: input.owner,
                amount,
                caveats,
            }),
        },
        owner,
    ))
}

/// The lock whose bond backs a spend by `spender` that names `lock_seq`: that lock when it names
/// one, else the lock of the nearest earlier spend that names one (`earlier` is every earlier
/// holder with the lock it named, oldest first), else the issuer's. Only [`backer`] says whether a
/// spend that names no lock has a lock to blame at all.
pub fn liable_lock(
    issuer: &[u8; 33],
    issue_lock_seq: u32,
    earlier: &[([u8; 33], u32)],
    spender: &[u8; 33],
    lock_seq: u32,
) -> ([u8; 33], u32) {
    if lock_seq != NO_LOCK {
        return (*spender, lock_seq);
    }
    earlier
        .iter()
        .rev()
        .find(|(_, seq)| *seq != NO_LOCK)
        .map_or((*issuer, issue_lock_seq), |&(key, seq)| (key, seq))
}

/// The lock that is liable for a spend by `spender` that names `lock_seq`, or `None` when no lock
/// is. A spend that names a lock is backed by it. A spend that names none is backed by the chain's
/// lock only when the output it consumes is `DELEGATED` or `AUTHORITY_ONLY` (`unlocked`, the rules
/// as they bind the holder): a plain settlement to a terminal account is backed by nothing, since
/// no receiver accepted it offline, so nobody can be defrauded by one and no bond answers for it.
pub fn backer(
    issuer: &[u8; 33],
    issue_lock_seq: u32,
    earlier: &[([u8; 33], u32)],
    spender: &[u8; 33],
    lock_seq: u32,
    unlocked: bool,
) -> Option<([u8; 33], u32)> {
    if lock_seq == NO_LOCK && !unlocked {
        return None;
    }
    Some(liable_lock(
        issuer,
        issue_lock_seq,
        earlier,
        spender,
        lock_seq,
    ))
}

#[cfg(test)]
mod liability_tests {
    extern crate std;
    use super::*;
    use proptest::prelude::*;

    fn key(tag: u8) -> [u8; 33] {
        let mut key = [tag; 33];
        key[0] = 0x02;
        key
    }

    #[test]
    fn a_spend_that_names_a_lock_is_backed_by_that_lock_of_its_spender() {
        assert_eq!(
            liable_lock(&key(1), 9, &[(key(2), 4)], &key(3), 7),
            (key(3), 7)
        );
    }

    #[test]
    fn a_spend_without_a_lock_is_backed_by_the_nearest_earlier_named_lock() {
        let earlier = [
            (key(2), 4),
            (key(3), NO_LOCK),
            (key(4), 6),
            (key(5), NO_LOCK),
        ];
        assert_eq!(
            liable_lock(&key(1), 9, &earlier, &key(6), NO_LOCK),
            (key(4), 6)
        );
    }

    #[test]
    fn a_spend_without_a_lock_and_with_none_before_is_backed_by_the_issuer() {
        assert_eq!(liable_lock(&key(1), 9, &[], &key(6), NO_LOCK), (key(1), 9));
        let earlier = [(key(2), NO_LOCK), (key(3), NO_LOCK)];
        assert_eq!(
            liable_lock(&key(1), 9, &earlier, &key(6), NO_LOCK),
            (key(1), 9)
        );
    }

    proptest! {
        #[test]
        fn the_liable_lock_is_always_one_the_chain_names(
            issuer in 1u8..255, issue_seq in 0u32..1000, spender in 1u8..255,
            seq in prop_oneof![Just(NO_LOCK), 0u32..1000],
            earlier in proptest::collection::vec((1u8..255, prop_oneof![Just(NO_LOCK), 0u32..1000]), 0..8),
        ) {
            let earlier: std::vec::Vec<([u8; 33], u32)> =
                earlier.into_iter().map(|(k, s)| (key(k), s)).collect();
            let (k, s) = liable_lock(&key(issuer), issue_seq, &earlier, &key(spender), seq);
            prop_assert_ne!(s, NO_LOCK);
            let named = (k == key(spender) && s == seq)
                || earlier.iter().any(|&(ek, es)| ek == k && es == s)
                || (k == key(issuer) && s == issue_seq);
            prop_assert!(named);
            if seq != NO_LOCK {
                prop_assert_eq!((k, s), (key(spender), seq));
            }
        }
    }

    #[test]
    fn a_plain_settlement_is_backed_by_nothing() {
        let earlier = [(key(2), 4)];
        assert_eq!(backer(&key(1), 9, &earlier, &key(3), NO_LOCK, false), None);
        assert_eq!(backer(&key(1), 9, &[], &key(3), NO_LOCK, false), None);
    }

    #[test]
    fn a_delegated_or_authority_only_spend_without_a_lock_is_backed_by_the_chains_lock() {
        let earlier = [(key(2), 4), (key(3), NO_LOCK)];
        assert_eq!(
            backer(&key(1), 9, &earlier, &key(6), NO_LOCK, true),
            Some((key(2), 4))
        );
        assert_eq!(
            backer(&key(1), 9, &[], &key(6), NO_LOCK, true),
            Some((key(1), 9))
        );
    }

    #[test]
    fn a_spend_that_names_a_lock_is_backed_by_it_whether_or_not_the_output_is_unlocked() {
        for unlocked in [false, true] {
            assert_eq!(
                backer(&key(1), 9, &[(key(2), 4)], &key(3), 7, unlocked),
                Some((key(3), 7))
            );
        }
    }

    proptest! {
        /// Whatever the chain, a lock answers for a spend only if the spend names it, or the
        /// output it consumed was delegated or authority-only and the chain names it.
        #[test]
        fn a_lock_is_blamed_only_when_it_named_itself_or_a_delegation_points_at_it(
            issuer in 1u8..255, issue_seq in 0u32..1000, spender in 1u8..255,
            seq in prop_oneof![Just(NO_LOCK), 0u32..1000], unlocked in any::<bool>(),
            earlier in proptest::collection::vec((1u8..255, prop_oneof![Just(NO_LOCK), 0u32..1000]), 0..8),
        ) {
            let earlier: std::vec::Vec<([u8; 33], u32)> =
                earlier.into_iter().map(|(k, s)| (key(k), s)).collect();
            let blamed = backer(&key(issuer), issue_seq, &earlier, &key(spender), seq, unlocked);
            match blamed {
                None => prop_assert!(seq == NO_LOCK && !unlocked),
                Some((k, s)) => {
                    prop_assert_ne!(s, NO_LOCK);
                    if seq != NO_LOCK {
                        prop_assert_eq!((k, s), (key(spender), seq));
                    } else {
                        prop_assert!(unlocked);
                    }
                }
            }
        }
    }
}
