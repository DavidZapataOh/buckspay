use curve25519_dalek::edwards::CompressedEdwardsY;
use p256::ecdsa::{signature::Verifier, RecoveryId, Signature, VerifyingKey};

use crate::conflict::{IssueConflict, SpendConflict};
use crate::{
    flags, record, BondTicket, Caveats, Issue, Owner, ProtocolError, Result, ScopeKind, Signed,
    Spend, CHALLENGE, GRACE, MAX_DEPTH, NO_LOCK,
};
use crate::{lock::TICKET_TTL_MAX, slash::covers};

pub fn verify_signature(key: &[u8; 33], message: &[u8], signature: &[u8; 64]) -> Result<()> {
    let key = VerifyingKey::from_sec1_bytes(key).map_err(|_| ProtocolError::Signer)?;
    let signature = Signature::from_slice(signature).map_err(|_| ProtocolError::Signature)?;
    if signature.normalize_s() != signature {
        return Err(ProtocolError::Signature);
    }
    key.verify(message, &signature)
        .map_err(|_| ProtocolError::Signature)
}

fn recover(message: &[u8], signature: &[u8; 64], recovery: u8) -> Result<[u8; 33]> {
    let signature = Signature::from_slice(signature).map_err(|_| ProtocolError::Signature)?;
    let id = RecoveryId::from_byte(recovery).ok_or(ProtocolError::Signature)?;
    let key = VerifyingKey::recover_from_msg(message, &signature, id)
        .map_err(|_| ProtocolError::Signature)?;
    let mut out = [0; 33];
    out.copy_from_slice(key.to_sec1_point(true).as_bytes());
    Ok(out)
}

/// The recovery id that makes `signature` over `message` recover `key`.
pub fn recovery_id(key: &[u8; 33], message: &[u8], signature: &[u8; 64]) -> Result<u8> {
    (0..=RecoveryId::MAX)
        .find(|&id| recover(message, signature, id) == Ok(*key))
        .ok_or(ProtocolError::Signature)
}

fn recover_pair(
    (a, b): ([u8; 96], [u8; 96]),
    signature_a: &[u8; 64],
    signature_b: &[u8; 64],
    recovery: u8,
) -> Result<[u8; 33]> {
    let key = recover(&a, signature_a, recovery & 3)?;
    if recover(&b, signature_b, recovery >> 2)? != key {
        return Err(ProtocolError::Signer);
    }
    Ok(key)
}

pub fn recover_spend_signer(domain: &[u8; 32], conflict: &SpendConflict) -> Result<[u8; 33]> {
    recover_pair(
        conflict.envelopes(domain),
        &conflict.signature_a,
        &conflict.signature_b,
        conflict.recovery,
    )
}

pub fn recover_issue_signer(domain: &[u8; 32], conflict: &IssueConflict) -> Result<[u8; 33]> {
    recover_pair(
        conflict.envelopes(domain),
        &conflict.a.signature,
        &conflict.b.signature,
        conflict.recovery,
    )
}

pub fn verify_spend_conflict(
    domain: &[u8; 32],
    signer: &[u8; 33],
    conflict: &SpendConflict,
) -> Result<()> {
    if !conflict.is_equivocation() {
        return Err(ProtocolError::Linkage);
    }
    let (a, b) = conflict.envelopes(domain);
    verify_signature(signer, &a, &conflict.signature_a)?;
    verify_signature(signer, &b, &conflict.signature_b)
}

pub fn verify_issue_conflict(
    domain: &[u8; 32],
    issuer: &[u8; 33],
    conflict: &IssueConflict,
) -> Result<()> {
    if !conflict.is_over_issuance() {
        return Err(ProtocolError::Linkage);
    }
    let (a, b) = conflict.envelopes(domain);
    verify_signature(issuer, &a, &conflict.a.signature)?;
    verify_signature(issuer, &b, &conflict.b.signature)
}

pub use crate::chain::Output;
use crate::chain::{self, Holding};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Attester {
    pub id: u16,
    pub key: [u8; 32],
}

/// What the receiving wallet trusts and requires.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Receiver<'a> {
    pub note_domain: [u8; 32],
    /// The settlement program the receiver will settle through: every output it depends on must
    /// have a record address and a claim address under it.
    pub program: [u8; 32],
    pub ticket_domain: [u8; 32],
    pub attesters: &'a [Attester],
    pub me: Owner,
    pub now: u32,
    pub min_window: u32,
    /// Accepts category-scoped payments; only for a receiver that checks categories itself.
    pub accept_category: bool,
    /// Account addresses of the authorities whose `AUTHORITY_ONLY` notes a device accepts,
    /// redeemable only by paying them to that authority (a closed circuit the holder has joined).
    pub accept_authorities: &'a [[u8; 32]],
}

/// A lock whose bond backs a payment, with the bond its ticket shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Liability {
    pub device: [u8; 33],
    pub lock_seq: u32,
    pub bond: u64,
}

/// The distinct locks liable for a payment, in chain order: the issuer's, then each lock a
/// spender named. A spend without a lock adds none: the lock backing it, that of the nearest
/// earlier spend naming one or the issuer's, is already listed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Liabilities {
    locks: [Liability; MAX_DEPTH as usize + 1],
    len: usize,
}

impl Liabilities {
    fn new() -> Liabilities {
        let none = Liability {
            device: [0; 33],
            lock_seq: 0,
            bond: 0,
        };
        Liabilities {
            locks: [none; MAX_DEPTH as usize + 1],
            len: 0,
        }
    }

    fn add(&mut self, lock: Liability) -> Result<()> {
        if self
            .iter()
            .any(|l| l.device == lock.device && l.lock_seq == lock.lock_seq)
        {
            return Ok(());
        }
        *self.locks.get_mut(self.len).ok_or(ProtocolError::Depth)? = lock;
        self.len += 1;
        Ok(())
    }
}

impl core::ops::Deref for Liabilities {
    type Target = [Liability];

    fn deref(&self) -> &[Liability] {
        &self.locks[..self.len]
    }
}

/// A chain that ends in a terminal account, as the program settles it: output 0 of its last
/// message, with the issue backing it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settled {
    pub output: Output,
    pub mint: [u8; 32],
    pub issuer: [u8; 33],
    pub lock_seq: u32,
}

impl Settled {
    fn new(issue: &Issue, output: Output) -> Settled {
        Settled {
            output,
            mint: issue.mint,
            issuer: issue.issuer,
            lock_seq: issue.lock_seq,
        }
    }
}

/// An accepted payment: output 0 of the last message, the issue backing it, and the locks liable
/// for it, so the wallet can keep a cumulative cap per lock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Received {
    pub output: Output,
    pub mint: [u8; 32],
    pub issuer: [u8; 33],
    pub lock_seq: u32,
    pub liable: Liabilities,
}

fn check_owner(owner: &Owner) -> Result<()> {
    if let Owner::Device(key) = owner {
        VerifyingKey::from_sec1_bytes(key).map_err(|_| ProtocolError::Owner)?;
    }
    Ok(())
}

pub(crate) fn verify_issue(domain: &[u8; 32], issue: &Signed<Issue>) -> Result<Output> {
    let message = &issue.message;
    message.check()?;
    check_owner(&message.owner)?;
    let (env, output) = chain::issue_signing(domain, message)?;
    verify_signature(&message.issuer, &env, &issue.signature)?;
    Ok(output)
}

pub(crate) fn verify_spend(
    domain: &[u8; 32],
    input: &Output,
    spend: &Signed<Spend>,
) -> Result<Holding> {
    let message = &spend.message;
    let (holder, env) = chain::spend_signing(domain, input, message)?;
    verify_signature(&holder, &env, &spend.signature)?;
    let (holding, owner) = chain::spend_outputs(&env, input, message)?;
    check_owner(&owner)?;
    Ok(holding)
}

/// Checks a spend of `input` before its holder signs it: `input` is a device's output that `spend`
/// names, the hop follows the rules receivers and the program apply (amount, change, attenuation,
/// scope, lock), and `input` can still move at `now`: until its expiry as a payment, until
/// `expiry + GRACE` as a settlement.
///
/// The spend must also be recordable: `input` and every output the spend creates have a record
/// address and a claim address under `program`; the signer changes the salt until they do.
pub fn check_spend_step(
    domain: &[u8; 32],
    program: &[u8; 32],
    input: &Output,
    spend: &Spend,
    now: u32,
) -> Result<()> {
    if !matches!(input.owner, Owner::Device(_)) {
        return Err(ProtocolError::Owner);
    }
    spend.check()?;
    if spend.input != input.id {
        return Err(ProtocolError::Linkage);
    }
    let grace = if chain::settles(spend) { GRACE } else { 0 };
    if u64::from(now) > u64::from(input.caveats.expiry) + u64::from(grace) {
        return Err(ProtocolError::Expired);
    }
    let (owner, ..) = chain::hop(input, spend)?;
    check_owner(&owner)?;
    recordable(program, &input.id)?;
    let (_, env) = chain::spend_signing(domain, input, spend)?;
    let (holding, _) = chain::spend_outputs(&env, input, spend)?;
    for output in [Some(holding.first), holding.second].into_iter().flatten() {
        recordable(program, &output.id)?;
    }
    Ok(())
}

/// Checks an issue before its issuer signs it: its output has a record address and a claim
/// address under `program` (the issuer changes the salt until it does).
pub fn check_issue_step(domain: &[u8; 32], program: &[u8; 32], issue: &Issue) -> Result<()> {
    let (_, output) = chain::issue_signing(domain, issue)?;
    recordable(program, &output.id)
}

/// An output a receiver accepts offline can be settled and, if its chain is a fraud, claimed.
fn recordable(program: &[u8; 32], output: &[u8; 32]) -> Result<()> {
    record::recordable(program, output)
        .then_some(())
        .ok_or(ProtocolError::Unrecordable)
}

/// An output settled on chain needs a record address only: nobody claims what is being paid.
fn spent_recordable(program: &[u8; 32], output: &[u8; 32]) -> Result<()> {
    record::address(program, output)
        .map(drop)
        .ok_or(ProtocolError::Unrecordable)
}

/// Follows `spends` from the issue's output, each consuming either output of the previous
/// message, and returns output 0 of the last one. `check` sees each consumed output and its spend.
fn follow(
    domain: &[u8; 32],
    issued: Output,
    spends: &[Signed<Spend>],
    mut check: impl FnMut(&Output, &Signed<Spend>) -> Result<()>,
) -> Result<Output> {
    let mut holding = Holding {
        first: issued,
        second: None,
    };
    for spend in spends {
        let input = [Some(holding.first), holding.second]
            .into_iter()
            .flatten()
            .find(|output| output.id == spend.message.input)
            .ok_or(ProtocolError::Linkage)?;
        holding = verify_spend(domain, &input, spend)?;
        check(&input, spend)?;
    }
    Ok(holding.first)
}

/// A canonical encoding of a point in the prime-order subgroup, other than the identity.
fn prime_order(bytes: &[u8; 32]) -> bool {
    CompressedEdwardsY(*bytes)
        .decompress()
        .is_some_and(|point| {
            point.compress().to_bytes() == *bytes
                && point.is_torsion_free()
                && !point.is_small_order()
        })
}

fn attested(receiver: &Receiver, ticket: &BondTicket) -> bool {
    let Some(attester) = receiver.attesters.iter().find(|a| a.id == ticket.attester) else {
        return false;
    };
    let Ok(key) = ed25519_dalek::VerifyingKey::from_bytes(&attester.key) else {
        return false;
    };
    let signature = ed25519_dalek::Signature::from_bytes(&ticket.signature);
    prime_order(&attester.key)
        && prime_order(signature.r_bytes())
        && key
            .verify_strict(&ticket.signed_message(&receiver.ticket_domain), &signature)
            .is_ok()
}

/// A payment carries at most one ticket per message and at most one per lock, so a sender
/// cannot make the receiver check more signatures than the chain needs.
fn check_bounds(spends: &[Signed<Spend>], tickets: &[BondTicket]) -> Result<()> {
    if spends.len() > usize::from(MAX_DEPTH) {
        return Err(ProtocolError::Depth);
    }
    if tickets.len() > spends.len() + 1 {
        return Err(ProtocolError::Ticket);
    }
    for (i, a) in tickets.iter().enumerate() {
        let duplicate = tickets[i + 1..]
            .iter()
            .any(|b| b.device == a.device && b.lock_seq == a.lock_seq);
        if duplicate {
            return Err(ProtocolError::Ticket);
        }
    }
    Ok(())
}

/// Whether a ticket whose last second is `valid_until` can be used at `now`: it has not run out and is
/// not valid for more than `TICKET_TTL_MAX` from now, whatever its attester signed.
fn fresh(now: u32, valid_until: u32) -> bool {
    now <= valid_until && valid_until - now <= TICKET_TTL_MAX
}

/// The ticket for `(device, lock_seq)`, which must be on `mint`, locked beyond the conflict window
/// of `expiry` (a claim needs `now < lock_until`, so the last second of the window needs one more),
/// fresh (valid now and no longer than `TICKET_TTL_MAX` from now), cover the liability and be
/// signed by a trusted attester.
fn ticket(
    receiver: &Receiver,
    tickets: &[BondTicket],
    device: &Owner,
    lock_seq: u32,
    mint: &[u8; 32],
    expiry: u32,
    covers: impl Fn(&BondTicket) -> bool,
) -> Result<Liability> {
    let settled_by = u64::from(expiry) + u64::from(GRACE) + u64::from(CHALLENGE);
    let ticket = tickets
        .iter()
        .find(|t| Owner::Device(t.device) == *device && t.lock_seq == lock_seq)
        .ok_or(ProtocolError::Ticket)?;
    let valid = ticket.mint == *mint
        && u64::from(ticket.lock_until) > settled_by
        && fresh(receiver.now, ticket.valid_until)
        && covers(ticket)
        && attested(receiver, ticket);
    if !valid {
        return Err(ProtocolError::Ticket);
    }
    Ok(Liability {
        device: ticket.device,
        lock_seq,
        bond: ticket.bond,
    })
}

/// Whether `receiver.me` can redeem an output with `caveats`: a merchant scope must name it, an
/// authority scope must name it as an account or be an `AUTHORITY_ONLY` note of an authority the
/// device trusts, and a category needs a receiver that checks it.
fn redeemable(receiver: &Receiver, caveats: &Caveats) -> bool {
    let rules = caveats.for_holder(&receiver.me);
    match (rules.scope_kind, receiver.me) {
        (ScopeKind::Any, _) => true,
        (ScopeKind::Category, _) => receiver.accept_category,
        (ScopeKind::Authority, Owner::Account(_)) => receiver.me.scope_hash() == rules.scope,
        (ScopeKind::Authority, Owner::Device(_)) => {
            rules.flags & flags::AUTHORITY_ONLY != 0
                && receiver
                    .accept_authorities
                    .iter()
                    .any(|&address| Owner::Account(address).scope_hash() == rules.scope)
        }
        (ScopeKind::Merchant, _) => false,
    }
}

/// Accepts a payment to `receiver.me`: output 0 of the last spend (or the issue's output when
/// there are no spends), never change, and only if `me` can redeem it. Stateless: the caller
/// rejects outputs and slots it has already accepted.
pub fn verify_payment(
    receiver: &Receiver,
    issue: &Signed<Issue>,
    spends: &[Signed<Spend>],
    tickets: &[BondTicket],
) -> Result<Received> {
    check_bounds(spends, tickets)?;
    let note = &issue.message;
    let issued = verify_issue(&receiver.note_domain, issue)?;
    let mut liable = Liabilities::new();
    liable.add(ticket(
        receiver,
        tickets,
        &Owner::Device(note.issuer),
        note.lock_seq,
        &note.mint,
        note.caveats.expiry,
        |t| covers(t.bond, note.amount) && t.backing >= note.cum_end,
    )?)?;
    let output = follow(&receiver.note_domain, issued, spends, |input, spend| {
        recordable(&receiver.program, &input.id)?;
        if receiver.now > input.caveats.expiry {
            return Err(ProtocolError::Expired);
        }
        let lock_seq = spend.message.lock_seq;
        if lock_seq == NO_LOCK {
            return if chain::unlocked(&input.caveats) {
                Ok(())
            } else {
                Err(ProtocolError::Lock)
            };
        }
        liable.add(ticket(
            receiver,
            tickets,
            &input.owner,
            lock_seq,
            &note.mint,
            input.caveats.expiry,
            |t| covers(t.bond, input.amount),
        )?)
    })?;
    recordable(&receiver.program, &output.id)?;
    if output.owner != receiver.me {
        return Err(ProtocolError::Payee);
    }
    if !redeemable(receiver, &output.caveats) {
        return Err(ProtocolError::Scope);
    }
    let window = u64::from(receiver.now) + u64::from(receiver.min_window);
    let stranded = matches!(output.owner, Owner::Device(_)) && output.caveats.hops_left == 0;
    if stranded || u64::from(output.caveats.expiry) < window {
        return Err(ProtocolError::Window);
    }
    Ok(Received {
        output,
        mint: note.mint,
        issuer: note.issuer,
        lock_seq: note.lock_seq,
        liable,
    })
}

/// Verifies a chain whose output 0 of the last message is a terminal account, for settlement
/// on chain. It checks neither time nor tickets: the program bounds settlement by the output's
/// expiry and slashes locks on conflict.
pub fn verify_settlement(
    domain: &[u8; 32],
    program: &[u8; 32],
    issue: &Signed<Issue>,
    spends: &[Signed<Spend>],
) -> Result<Settled> {
    let output = follow(domain, verify_issue(domain, issue)?, spends, |input, _| {
        spent_recordable(program, &input.id)
    })?;
    if spends.is_empty() {
        spent_recordable(program, &output.id)?;
    }
    match output.owner {
        Owner::Account(_) => Ok(Settled::new(&issue.message, output)),
        Owner::Device(_) => Err(ProtocolError::Payee),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conflict::IssueClaim;
    use crate::hash::content;
    use crate::hash::envelope;
    use crate::message::issue_slot;
    use crate::slash::min_bond;
    use crate::Outputs;
    use crate::ScopeKind;
    use ed25519_dalek::Signer as _;
    use p256::ecdsa::{signature::Signer, SigningKey};

    fn key(seed: u8) -> (SigningKey, [u8; 33]) {
        let signing = SigningKey::from_slice(&[seed; 32]).unwrap();
        let mut public = [0; 33];
        public.copy_from_slice(signing.verifying_key().to_sec1_point(true).as_bytes());
        (signing, public)
    }

    fn sign(signing: &SigningKey, message: &[u8]) -> [u8; 64] {
        let signature: Signature = signing.sign(message);
        signature.normalize_s().to_bytes().into()
    }

    fn high_s(signature: &[u8; 64]) -> [u8; 64] {
        let parsed = Signature::from_slice(signature).unwrap();
        let (r, s) = parsed.split_scalars();
        Signature::from_scalars(r, -*s).unwrap().to_bytes().into()
    }

    const DOMAIN: [u8; 32] = [9; 32];

    #[test]
    fn accepts_low_s_and_rejects_high_s() {
        let (signing, public) = key(1);
        let signature = sign(&signing, b"note");
        assert_eq!(verify_signature(&public, b"note", &signature), Ok(()));
        assert_eq!(
            verify_signature(&public, b"note", &high_s(&signature)),
            Err(ProtocolError::Signature)
        );
    }

    fn spend_conflict(signing: &SigningKey, public: &[u8; 33], domain: &[u8; 32]) -> SpendConflict {
        let slot = [4; 32];
        let a = envelope(domain, &slot, &[1; 32]);
        let b = envelope(domain, &slot, &[2; 32]);
        let (signature_a, signature_b) = (sign(signing, &a), sign(signing, &b));
        SpendConflict {
            slot,
            content_a: [1; 32],
            signature_a,
            content_b: [2; 32],
            signature_b,
            recovery: recovery_id(public, &a, &signature_a).unwrap()
                | recovery_id(public, &b, &signature_b).unwrap() << 2,
        }
    }

    #[test]
    fn equivocation_is_proven_by_two_signed_contents() {
        let (signing, public) = key(1);
        let conflict = spend_conflict(&signing, &public, &DOMAIN);
        assert_eq!(recover_spend_signer(&DOMAIN, &conflict), Ok(public));
        assert_eq!(verify_spend_conflict(&DOMAIN, &public, &conflict), Ok(()));
    }

    #[test]
    fn recovery_requires_both_signatures_to_name_one_key() {
        let (signing, public) = key(1);
        let (other, other_public) = key(2);
        let mut conflict = spend_conflict(&signing, &public, &DOMAIN);
        let (_, b) = conflict.envelopes(&DOMAIN);
        conflict.signature_b = sign(&other, &b);
        conflict.recovery = conflict.recovery & 3
            | recovery_id(&other_public, &b, &conflict.signature_b).unwrap() << 2;
        assert_eq!(
            recover_spend_signer(&DOMAIN, &conflict),
            Err(ProtocolError::Signer)
        );
        assert_eq!(
            recovery_id(&other_public, &b, &sign(&signing, &b)),
            Err(ProtocolError::Signature)
        );
    }

    #[test]
    fn malleated_copy_does_not_frame_an_honest_signer() {
        let (signing, public) = key(1);
        let conflict = spend_conflict(&signing, &public, &DOMAIN);
        let framed = SpendConflict {
            content_b: conflict.content_a,
            signature_b: high_s(&conflict.signature_a),
            ..conflict
        };
        assert_eq!(
            verify_spend_conflict(&DOMAIN, &public, &framed),
            Err(ProtocolError::Linkage)
        );
    }

    #[test]
    fn conflict_from_another_domain_is_rejected() {
        let (signing, public) = key(1);
        let conflict = spend_conflict(&signing, &public, &[8; 32]);
        assert_eq!(
            verify_spend_conflict(&DOMAIN, &public, &conflict),
            Err(ProtocolError::Signature)
        );
    }

    #[test]
    fn over_issuance_is_proven() {
        let (signing, public) = key(2);
        let claim = |start, end, content: u8| {
            let env = envelope(&DOMAIN, &issue_slot(1, start, end), &[content; 32]);
            let signature = sign(&signing, &env);
            let recovery = recovery_id(&public, &env, &signature).unwrap();
            let claim = IssueClaim {
                lock_seq: 1,
                start,
                end,
                content: [content; 32],
                signature,
            };
            (claim, recovery)
        };
        let ((a, recovery_a), (b, recovery_b)) = (claim(0, 100, 1), claim(60, 120, 2));
        let conflict = IssueConflict {
            a,
            b,
            recovery: recovery_a | recovery_b << 2,
        };
        assert_eq!(recover_issue_signer(&DOMAIN, &conflict), Ok(public));
        assert_eq!(verify_issue_conflict(&DOMAIN, &public, &conflict), Ok(()));
    }

    const NOW: u32 = 1_800_000_000;
    const EXPIRY: u32 = 1_900_000_000;
    const TICKET_DOMAIN: [u8; 32] = [10; 32];
    const MINT: [u8; 32] = [3; 32];
    const PROGRAM: [u8; 32] = [7; 32];
    use crate::lock::EXPIRY_STEP;

    fn recordable_id(id: &[u8; 32]) -> bool {
        record::recordable(&PROGRAM, id)
    }

    fn caveats(hops_left: u8) -> Caveats {
        Caveats {
            expiry: EXPIRY,
            hops_left,
            flags: 0,
            scope_kind: ScopeKind::Any,
            scope: [0; 20],
        }
    }

    fn attester() -> ed25519_dalek::SigningKey {
        ed25519_dalek::SigningKey::from_bytes(&[11; 32])
    }

    fn ticket(device: [u8; 33], bond: u64, lock_until: u32) -> BondTicket {
        let mut ticket = BondTicket {
            device,
            mint: MINT,
            lock_seq: 0,
            bond,
            backing: 20_000,
            lock_until,
            valid_until: NOW + 86_400,
            attester: 1,
            signature: [0; 64],
        };
        let message = ticket.signed_message(&TICKET_DOMAIN);
        ticket.signature = attester().sign(&message).to_bytes();
        ticket
    }

    fn valid_until(mut ticket: BondTicket, valid_until: u32) -> BondTicket {
        ticket.valid_until = valid_until;
        let message = ticket.signed_message(&TICKET_DOMAIN);
        ticket.signature = attester().sign(&message).to_bytes();
        ticket
    }

    fn receiver<'a>(attesters: &'a [Attester], me: [u8; 33]) -> Receiver<'a> {
        Receiver {
            note_domain: DOMAIN,
            program: PROGRAM,
            ticket_domain: TICKET_DOMAIN,
            attesters,
            me: Owner::Device(me),
            now: NOW,
            min_window: 86_400,
            accept_category: false,
            accept_authorities: &[],
        }
    }

    fn attesters() -> [Attester; 1] {
        [Attester {
            id: 1,
            key: attester().verifying_key().to_bytes(),
        }]
    }

    /// The salt is changed until the issue's output is recordable, as an honest issuer does.
    fn signed_issue(issuer: &SigningKey, issuer_key: [u8; 33], owner: [u8; 33]) -> Signed<Issue> {
        (0u8..)
            .map(|salt| {
                let message = Issue {
                    issuer: issuer_key,
                    mint: MINT,
                    lock_seq: 0,
                    cum_end: 20_000,
                    salt: [salt; 16],
                    owner: Owner::Device(owner),
                    amount: 20_000,
                    caveats: caveats(4),
                };
                let env = envelope(&DOMAIN, &message.slot().unwrap(), &content(&message.body()));
                Signed {
                    message,
                    signature: sign(issuer, &env),
                }
            })
            .find(|issue| recordable_id(&issued_output(issue)))
            .unwrap()
    }

    fn issued_output(issue: &Signed<Issue>) -> [u8; 32] {
        chain::issue_signing(&DOMAIN, &issue.message).unwrap().1.id
    }

    /// The salt is changed until every output the spend creates is recordable. A spend
    /// that breaks a rule keeps its first salt: the tests that use it expect the rule's error.
    fn signed_spend(holder: &SigningKey, input: &Output, outputs: Outputs) -> Signed<Spend> {
        let build = |salt: u8| {
            let message = Spend {
                input: input.id,
                lock_seq: 0,
                salt: [salt; 16],
                outputs,
            };
            let env = envelope(&DOMAIN, &input.id, &message.content());
            let ready = chain::spend_outputs(&env, input, &message).map_or(true, |(holding, _)| {
                [Some(holding.first), holding.second]
                    .into_iter()
                    .flatten()
                    .all(|o| recordable_id(&o.id))
            });
            (
                Signed {
                    message,
                    signature: sign(holder, &env),
                },
                ready,
            )
        };
        (0u8..).map(build).find(|(_, ready)| *ready).unwrap().0
    }

    /// The caveats of a payment `depth` steps below the issue: one hop less and `EXPIRY_STEP`
    /// shorter at each step.
    fn payment_caveats(hops_left: u8, depth: u32) -> Caveats {
        Caveats {
            expiry: EXPIRY - depth * EXPIRY_STEP,
            ..caveats(hops_left)
        }
    }

    #[test]
    fn three_hop_payment_with_change_verifies() {
        let (issuer, issuer_key) = key(1);
        let (alice, alice_key) = key(2);
        let (bob, bob_key) = key(3);
        let (_, carol_key) = key(4);
        let issue = signed_issue(&issuer, issuer_key, alice_key);
        let first = verify_issue(&DOMAIN, &issue).unwrap();
        let to_bob = signed_spend(
            &alice,
            &first,
            Outputs::Two {
                owner0: Owner::Device(bob_key),
                amount0: 12_000,
                caveats0: payment_caveats(3, 1),
                owner1: Owner::Device(alice_key),
            },
        );
        let bob_output = verify_spend(&DOMAIN, &first, &to_bob).unwrap().first;
        let to_carol = signed_spend(
            &bob,
            &bob_output,
            Outputs::One {
                owner: Owner::Device(carol_key),
                caveats: payment_caveats(2, 2),
            },
        );
        let lock_until = EXPIRY + GRACE + CHALLENGE + 1;
        let tickets = [
            ticket(issuer_key, min_bond(20_000).unwrap(), lock_until),
            ticket(alice_key, min_bond(20_000).unwrap(), lock_until),
            ticket(bob_key, min_bond(12_000).unwrap(), lock_until),
        ];
        let attesters = attesters();

        let received = verify_payment(
            &receiver(&attesters, carol_key),
            &issue,
            &[to_bob, to_carol],
            &tickets,
        )
        .unwrap();

        assert_eq!(received.output.owner, Owner::Device(carol_key));
        assert_eq!(received.output.amount, 12_000);
        assert_eq!(received.mint, MINT);
        assert_eq!(received.issuer, issuer_key);
        assert_eq!(received.lock_seq, 0);
        let lock = |device, bond| Liability {
            device,
            lock_seq: 0,
            bond,
        };
        assert_eq!(
            *received.liable,
            [
                lock(issuer_key, min_bond(20_000).unwrap()),
                lock(alice_key, min_bond(20_000).unwrap()),
                lock(bob_key, min_bond(12_000).unwrap())
            ]
        );
    }

    #[test]
    fn locked_spends_need_a_bonded_ticket_from_a_known_attester() {
        let (issuer, issuer_key) = key(1);
        let (alice, alice_key) = key(2);
        let (_, bob_key) = key(3);
        let issue = signed_issue(&issuer, issuer_key, alice_key);
        let first = verify_issue(&DOMAIN, &issue).unwrap();
        let to_bob = signed_spend(
            &alice,
            &first,
            Outputs::One {
                owner: Owner::Device(bob_key),
                caveats: payment_caveats(3, 1),
            },
        );
        let lock_until = EXPIRY + GRACE + CHALLENGE + 1;
        let issuer_ticket = ticket(issuer_key, min_bond(20_000).unwrap(), lock_until);
        let forged = BondTicket {
            bond: 1_000_000,
            ..ticket(alice_key, min_bond(20_000).unwrap(), lock_until)
        };
        let attesters = attesters();
        let receiver = receiver(&attesters, bob_key);
        for alice_ticket in [
            None,
            Some(ticket(alice_key, min_bond(20_000).unwrap() - 1, lock_until)),
            Some(ticket(alice_key, min_bond(20_000).unwrap(), lock_until - 1)),
            Some(forged),
        ] {
            let tickets: &[BondTicket] = match &alice_ticket {
                Some(t) => &[issuer_ticket, *t],
                None => &[issuer_ticket],
            };
            assert_eq!(
                verify_payment(&receiver, &issue, &[to_bob], tickets),
                Err(ProtocolError::Ticket)
            );
        }
        let tickets = [
            issuer_ticket,
            ticket(alice_key, min_bond(20_000).unwrap(), lock_until),
        ];
        assert!(verify_payment(&receiver, &issue, &[to_bob], &tickets).is_ok());
        assert_eq!(
            verify_payment(
                &Receiver {
                    attesters: &[],
                    ..receiver
                },
                &issue,
                &[to_bob],
                &tickets
            ),
            Err(ProtocolError::Ticket)
        );
    }

    #[test]
    fn change_carries_the_remainder_and_one_hop_less() {
        let (issuer, issuer_key) = key(1);
        let (alice, alice_key) = key(2);
        let (_, bob_key) = key(3);
        let issue = signed_issue(&issuer, issuer_key, alice_key);
        let first = verify_issue(&DOMAIN, &issue).unwrap();
        let spend = signed_spend(
            &alice,
            &first,
            Outputs::Two {
                owner0: Owner::Device(bob_key),
                amount0: 5_000,
                caveats0: payment_caveats(3, 1),
                owner1: Owner::Device(alice_key),
            },
        );
        let change = verify_spend(&DOMAIN, &first, &spend)
            .unwrap()
            .second
            .unwrap();
        assert_eq!(change.owner, Owner::Device(alice_key));
        assert_eq!(change.amount, 15_000);
        assert_eq!(change.caveats, caveats(3));
    }

    #[test]
    fn rejects_payment_not_smaller_than_input() {
        let (issuer, issuer_key) = key(1);
        let (alice, alice_key) = key(2);
        let issue = signed_issue(&issuer, issuer_key, alice_key);
        let first = verify_issue(&DOMAIN, &issue).unwrap();
        let spend = signed_spend(
            &alice,
            &first,
            Outputs::Two {
                owner0: Owner::Device(alice_key),
                amount0: 20_000,
                caveats0: caveats(3),
                owner1: Owner::Device(alice_key),
            },
        );
        assert_eq!(
            verify_spend(&DOMAIN, &first, &spend),
            Err(ProtocolError::Amount)
        );
    }

    #[test]
    fn rejects_spend_by_someone_else() {
        let (issuer, issuer_key) = key(1);
        let (_, alice_key) = key(2);
        let (mallory, mallory_key) = key(5);
        let issue = signed_issue(&issuer, issuer_key, alice_key);
        let first = verify_issue(&DOMAIN, &issue).unwrap();
        let theft = signed_spend(
            &mallory,
            &first,
            Outputs::One {
                owner: Owner::Device(mallory_key),
                caveats: caveats(3),
            },
        );
        assert_eq!(
            verify_spend(&DOMAIN, &first, &theft),
            Err(ProtocolError::Signature)
        );
    }

    #[test]
    fn rejects_widened_caveats_expiry_and_foreign_domain() {
        let (issuer, issuer_key) = key(1);
        let (alice, alice_key) = key(2);
        let (_, bob_key) = key(3);
        let issue = signed_issue(&issuer, issuer_key, alice_key);
        let first = verify_issue(&DOMAIN, &issue).unwrap();
        let widened = signed_spend(
            &alice,
            &first,
            Outputs::One {
                owner: Owner::Device(bob_key),
                caveats: caveats(4),
            },
        );
        assert_eq!(
            verify_spend(&DOMAIN, &first, &widened),
            Err(ProtocolError::Attenuation)
        );
        let fine = signed_spend(
            &alice,
            &first,
            Outputs::One {
                owner: Owner::Device(bob_key),
                caveats: payment_caveats(3, 1),
            },
        );
        let lock_until = EXPIRY + GRACE + CHALLENGE + 1;
        let tickets = [
            valid_until(
                ticket(issuer_key, min_bond(20_000).unwrap(), lock_until),
                EXPIRY + 86_400,
            ),
            valid_until(
                ticket(alice_key, min_bond(20_000).unwrap(), lock_until),
                EXPIRY + 86_400,
            ),
        ];
        let attesters = attesters();
        let late = Receiver {
            now: EXPIRY + 1,
            ..receiver(&attesters, bob_key)
        };
        assert_eq!(
            verify_payment(&late, &issue, &[fine], &tickets),
            Err(ProtocolError::Expired)
        );
        assert_eq!(
            verify_issue(&[8; 32], &issue),
            Err(ProtocolError::Signature)
        );
    }

    #[test]
    fn rejects_spend_of_a_terminal_account_output() {
        let (issuer, issuer_key) = key(1);
        let (alice, _) = key(2);
        let message = Issue {
            owner: Owner::Account([5; 32]),
            ..signed_issue(&issuer, issuer_key, issuer_key).message
        };
        let env = envelope(&DOMAIN, &message.slot().unwrap(), &content(&message.body()));
        let issue = Signed {
            message,
            signature: sign(&issuer, &env),
        };
        let first = verify_issue(&DOMAIN, &issue).unwrap();
        let spend = signed_spend(
            &alice,
            &first,
            Outputs::One {
                owner: Owner::Account([6; 32]),
                caveats: caveats(3),
            },
        );
        assert_eq!(
            verify_spend(&DOMAIN, &first, &spend),
            Err(ProtocolError::Owner)
        );
    }

    #[test]
    fn rejects_outputs_to_keys_off_the_curve() {
        let (issuer, issuer_key) = key(1);
        let mut off_curve = [0xff; 33];
        off_curve[0] = 0x02;
        let issue = signed_issue(&issuer, issuer_key, off_curve);
        assert_eq!(verify_issue(&DOMAIN, &issue), Err(ProtocolError::Owner));
    }

    #[test]
    fn rejects_broken_linkage_and_payments_to_someone_else() {
        let (issuer, issuer_key) = key(1);
        let (alice, alice_key) = key(2);
        let (_, bob_key) = key(3);
        let issue = signed_issue(&issuer, issuer_key, alice_key);
        let first = verify_issue(&DOMAIN, &issue).unwrap();
        let unrelated = Output {
            id: [0; 32],
            ..first
        };
        let spend = signed_spend(
            &alice,
            &unrelated,
            Outputs::One {
                owner: Owner::Device(bob_key),
                caveats: caveats(3),
            },
        );
        let tickets = [ticket(
            issuer_key,
            min_bond(20_000).unwrap(),
            EXPIRY + GRACE + CHALLENGE + 1,
        )];
        let attesters = attesters();
        assert_eq!(
            verify_payment(&receiver(&attesters, bob_key), &issue, &[spend], &tickets),
            Err(ProtocolError::Linkage)
        );
        assert_eq!(
            verify_payment(&receiver(&attesters, bob_key), &issue, &[], &tickets),
            Err(ProtocolError::Payee)
        );
    }

    #[test]
    fn change_must_keep_a_hop() {
        let (issuer, issuer_key) = key(1);
        let (alice, alice_key) = key(2);
        let (_, bob_key) = key(3);
        let message = Issue {
            caveats: caveats(1),
            ..signed_issue(&issuer, issuer_key, alice_key).message
        };
        let env = envelope(&DOMAIN, &message.slot().unwrap(), &content(&message.body()));
        let issue = Signed {
            message,
            signature: sign(&issuer, &env),
        };
        let first = verify_issue(&DOMAIN, &issue).unwrap();
        let stranding = signed_spend(
            &alice,
            &first,
            Outputs::Two {
                owner0: Owner::Device(bob_key),
                amount0: 5_000,
                caveats0: caveats(0),
                owner1: Owner::Device(alice_key),
            },
        );
        assert_eq!(
            verify_spend(&DOMAIN, &first, &stranding),
            Err(ProtocolError::Depth)
        );
    }

    #[test]
    fn attester_keys_and_nonces_must_have_prime_order() {
        use curve25519_dalek::constants::{ED25519_BASEPOINT_POINT, EIGHT_TORSION};
        use curve25519_dalek::traits::Identity;
        let honest = attester().verifying_key().to_edwards();
        assert!(prime_order(&honest.compress().to_bytes()));
        assert!(prime_order(&ED25519_BASEPOINT_POINT.compress().to_bytes()));
        for torsion in &EIGHT_TORSION[1..] {
            assert!(!prime_order(&(honest + torsion).compress().to_bytes()));
            assert!(!prime_order(&torsion.compress().to_bytes()));
        }
        let identity = curve25519_dalek::EdwardsPoint::identity();
        assert!(!prime_order(&identity.compress().to_bytes()));
        let mut non_canonical = [0xff; 32];
        non_canonical[0] = 0xee;
        non_canonical[31] = 0x7f;
        assert!(!prime_order(&non_canonical));
    }

    #[test]
    fn a_device_redeems_authority_notes_only_for_authorities_it_trusts() {
        let organiser = Owner::Account([0xa0; 32]);
        let closed = Caveats {
            flags: flags::AUTHORITY_ONLY,
            scope_kind: ScopeKind::Authority,
            scope: organiser.scope_hash(),
            ..caveats(3)
        };
        let attesters = attesters();
        let (_, attendee) = key(4);
        let untrusting = receiver(&attesters, attendee);
        assert!(!redeemable(&untrusting, &closed));
        let trusts_other = Receiver {
            accept_authorities: &[[0xb0; 32]],
            ..untrusting
        };
        assert!(!redeemable(&trusts_other, &closed));
        let trusted = [[0xb0; 32], [0xa0; 32]];
        let trusting = Receiver {
            accept_authorities: &trusted,
            ..untrusting
        };
        assert!(redeemable(&trusting, &closed));
        let unflagged = Caveats { flags: 0, ..closed };
        assert!(!redeemable(&trusting, &unflagged));
        let another_account = Receiver {
            me: Owner::Account([0xb0; 32]),
            ..trusting
        };
        assert!(!redeemable(&another_account, &closed));
        let authority = Receiver {
            me: organiser,
            ..untrusting
        };
        assert!(redeemable(&authority, &closed));
    }

    #[test]
    fn a_spend_is_checked_against_its_input_before_it_is_signed() {
        let (_, alice_key) = key(2);
        let (_, bob_key) = key(3);
        let (alice, bob) = (Owner::Device(alice_key), Owner::Device(bob_key));
        let account = Owner::Account([0xb5; 32]);
        let input = Output {
            id: (0u8..).map(|b| [b; 32]).find(recordable_id).unwrap(),
            owner: alice,
            amount: 20_000,
            caveats: caveats(4),
        };
        let check = |spend: &Spend, now| check_spend_step(&DOMAIN, &PROGRAM, &input, spend, now);
        // The salt is changed until the spend is recordable, as the signer does.
        let spend = |lock_seq, outputs| {
            (0u8..)
                .map(|salt| Spend {
                    input: input.id,
                    lock_seq,
                    salt: [salt; 16],
                    outputs,
                })
                .find(|s| check(s, NOW) != Err(ProtocolError::Unrecordable))
                .unwrap()
        };
        let pay = |hops_left| Outputs::One {
            owner: bob,
            caveats: payment_caveats(hops_left, 1),
        };
        let split = |amount0, owner1| Outputs::Two {
            owner0: bob,
            amount0,
            caveats0: payment_caveats(3, 1),
            owner1,
        };
        let settle = spend(
            NO_LOCK,
            Outputs::One {
                owner: account,
                caveats: caveats(3),
            },
        );

        assert_eq!(check(&spend(0, pay(3)), NOW), Ok(()));
        assert_eq!(check(&spend(0, split(12_000, alice)), NOW), Ok(()));
        assert_eq!(
            check(&spend(0, split(20_000, alice)), NOW),
            Err(ProtocolError::Amount)
        );
        assert_eq!(
            check(&spend(0, split(12_000, bob)), NOW),
            Err(ProtocolError::Change)
        );
        assert_eq!(
            check(&spend(0, pay(4)), NOW),
            Err(ProtocolError::Attenuation)
        );
        assert_eq!(
            check(&spend(NO_LOCK, pay(3)), NOW),
            Err(ProtocolError::Lock)
        );
        let elsewhere = Spend {
            input: [8; 32],
            ..spend(0, pay(3))
        };
        assert_eq!(check(&elsewhere, NOW), Err(ProtocolError::Linkage));
        assert_eq!(check(&spend(0, pay(3)), EXPIRY), Ok(()));
        assert_eq!(
            check(&spend(0, pay(3)), EXPIRY + 1),
            Err(ProtocolError::Expired)
        );
        assert_eq!(check(&settle, EXPIRY + GRACE), Ok(()));
        assert_eq!(
            check(&settle, EXPIRY + GRACE + 1),
            Err(ProtocolError::Expired)
        );
        let held_by_account = Output {
            owner: account,
            ..input
        };
        assert_eq!(
            check_spend_step(&DOMAIN, &PROGRAM, &held_by_account, &settle, NOW),
            Err(ProtocolError::Owner)
        );
    }

    #[test]
    fn a_spend_whose_outputs_have_no_record_address_is_refused_to_its_signer() {
        let (_, alice_key) = key(2);
        let (_, bob_key) = key(3);
        let input = Output {
            id: (0u8..).map(|b| [b; 32]).find(recordable_id).unwrap(),
            owner: Owner::Device(alice_key),
            amount: 20_000,
            caveats: caveats(4),
        };
        let pay = |salt: u8, owner| Spend {
            input: input.id,
            lock_seq: 0,
            salt: [salt; 16],
            outputs: Outputs::One {
                owner,
                caveats: payment_caveats(3, 1),
            },
        };
        let check = |spend: &Spend| check_spend_step(&DOMAIN, &PROGRAM, &input, spend, NOW);
        let output_id = |spend: &Spend| {
            let (_, env) = chain::spend_signing(&DOMAIN, &input, spend).unwrap();
            let (holding, _) = chain::spend_outputs(&env, &input, spend).unwrap();
            holding.first.id
        };
        // Some salt gives the device an output without a record address: the signer must try another.
        let to_device = |salt| pay(salt, Owner::Device(bob_key));
        let bad = (0u8..)
            .map(to_device)
            .find(|s| !recordable_id(&output_id(s)))
            .unwrap();
        let good = (0u8..)
            .map(to_device)
            .find(|s| recordable_id(&output_id(s)))
            .unwrap();
        assert_eq!(check(&bad), Err(ProtocolError::Unrecordable));
        assert_eq!(check(&good), Ok(()));
        // A terminal account's output needs the addresses too: a receiver accepts it offline and a
        // claim for its loss is keyed by it.
        let to_account = |salt| pay(salt, Owner::Account([5; 32]));
        let bad_for_an_account = (0u8..)
            .map(to_account)
            .find(|s| !recordable_id(&output_id(s)))
            .unwrap();
        assert_eq!(check(&bad_for_an_account), Err(ProtocolError::Unrecordable));
        // An input without a record address cannot be spent: its signer could never settle it.
        let unrecordable_input = Output {
            id: (0u8..)
                .map(|b| [b; 32])
                .find(|id| !recordable_id(id))
                .unwrap(),
            ..input
        };
        let respend = Spend {
            input: unrecordable_input.id,
            ..good
        };
        assert_eq!(
            check_spend_step(&DOMAIN, &PROGRAM, &unrecordable_input, &respend, NOW),
            Err(ProtocolError::Unrecordable)
        );
    }

    #[test]
    fn an_issue_whose_output_has_no_record_address_is_refused_to_its_issuer() {
        let (_, issuer_key) = key(1);
        let (_, alice_key) = key(2);
        let issue = |salt: u8| Issue {
            issuer: issuer_key,
            mint: MINT,
            lock_seq: 0,
            cum_end: 20_000,
            salt: [salt; 16],
            owner: Owner::Device(alice_key),
            amount: 20_000,
            caveats: caveats(4),
        };
        let recordable =
            |salt| recordable_id(&chain::issue_signing(&DOMAIN, &issue(salt)).unwrap().1.id);
        let bad = (0u8..).find(|s| !recordable(*s)).unwrap();
        let good = (0u8..).find(|s| recordable(*s)).unwrap();
        assert_eq!(
            check_issue_step(&DOMAIN, &PROGRAM, &issue(bad)),
            Err(ProtocolError::Unrecordable)
        );
        assert_eq!(check_issue_step(&DOMAIN, &PROGRAM, &issue(good)), Ok(()));
    }

    fn pay_issue_with(ticket: BondTicket) -> Result<()> {
        let (issuer, issuer_key) = key(1);
        let (_, alice_key) = key(2);
        let issue = signed_issue(&issuer, issuer_key, alice_key);
        let attesters = attesters();
        verify_payment(&receiver(&attesters, alice_key), &issue, &[], &[ticket]).map(drop)
    }

    #[test]
    fn a_ticket_is_fresh_until_valid_until_and_never_for_longer_than_the_ttl_from_now() {
        use crate::lock::TICKET_TTL_MAX;
        let (_, issuer_key) = key(1);
        let lock_until = EXPIRY + GRACE + CHALLENGE + 1;
        let bond = min_bond(20_000).unwrap();
        let with = |until: u32| valid_until(ticket(issuer_key, bond, lock_until), until);
        assert_eq!(pay_issue_with(with(NOW - 1)), Err(ProtocolError::Ticket));
        assert_eq!(pay_issue_with(with(NOW)), Ok(()));
        assert_eq!(pay_issue_with(with(NOW + TICKET_TTL_MAX)), Ok(()));
        assert_eq!(
            pay_issue_with(with(NOW + TICKET_TTL_MAX + 1)),
            Err(ProtocolError::Ticket)
        );
        assert_eq!(pay_issue_with(with(u32::MAX)), Err(ProtocolError::Ticket));
    }

    #[test]
    fn the_lock_must_outlast_the_conflict_window_by_a_second() {
        let (_, issuer_key) = key(1);
        let settled_by = EXPIRY + GRACE + CHALLENGE;
        let bond = min_bond(20_000).unwrap();
        for (lock_until, ok) in [
            (settled_by - 1, false),
            (settled_by, false),
            (settled_by + 1, true),
        ] {
            let result = pay_issue_with(ticket(issuer_key, bond, lock_until));
            assert_eq!(result.is_ok(), ok, "lock_until {lock_until}");
        }
    }
}
