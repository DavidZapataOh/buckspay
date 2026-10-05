#![cfg(feature = "verify")]

use buckspay_protocol::hash::{content, domain, envelope, message_id, output_id, purpose};
use buckspay_protocol::slash::min_bond;
use buckspay_protocol::verify::{
    verify_issue_conflict, verify_payment, verify_settlement, verify_spend_conflict, Attester,
    Liability, Receiver,
};
use buckspay_protocol::{
    flags, BondTicket, Caveats, Issue, IssueClaim, IssueConflict, Outputs, Owner, ProtocolError,
    ScopeKind, Signed, Spend, SpendConflict, CHALLENGE, GRACE, NO_LOCK,
};
use buckspay_protocol::{lock::EXPIRY_STEP, record};
use ed25519_dalek::Signer as _;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};

const GENESIS: [u8; 32] = [1; 32];
const PROGRAM: [u8; 32] = [2; 32];
const NOW: u32 = 1_800_000_000;
const EXPIRY: u32 = 1_900_000_000;
const USDC: [u8; 32] = [3; 32];
const ORGANISER_ADDRESS: [u8; 32] = [0xa0; 32];
const ORGANISER: Owner = Owner::Account(ORGANISER_ADDRESS);

fn note_domain() -> [u8; 32] {
    domain(purpose::NOTE, &GENESIS, &PROGRAM)
}

fn ticket_domain() -> [u8; 32] {
    domain(purpose::TICKET, &GENESIS, &PROGRAM)
}

fn key(seed: u8) -> (SigningKey, Owner) {
    let signing = SigningKey::from_slice(&[seed; 32]).unwrap();
    let mut public = [0; 33];
    public.copy_from_slice(signing.verifying_key().to_sec1_point(true).as_bytes());
    (signing, Owner::Device(public))
}

fn sign(signing: &SigningKey, message: &[u8]) -> [u8; 64] {
    let signature: Signature = signing.sign(message);
    signature.normalize_s().to_bytes().into()
}

/// A note is issued with four hops: the payment after each hop expires `EXPIRY_STEP` before the
/// output it spends, as the chain rules require for payments to devices.
fn caveats(hops_left: u8, flags: u8, expiry: u32) -> Caveats {
    let steps = if expiry == EXPIRY {
        4u32.saturating_sub(u32::from(hops_left))
    } else {
        0
    };
    Caveats {
        expiry: expiry - steps * EXPIRY_STEP,
        hops_left,
        flags,
        scope_kind: ScopeKind::Any,
        scope: [0; 20],
    }
}

fn issued_id(issue: &Signed<Issue>) -> [u8; 32] {
    let message = &issue.message;
    let env = envelope(
        &note_domain(),
        &message.slot().unwrap(),
        &content(&message.body()),
    );
    output_id(&message_id(&env), 0)
}

fn spent_id(spend: &Signed<Spend>, index: u8) -> [u8; 32] {
    let env = envelope(
        &note_domain(),
        &spend.message.input,
        &spend.message.content(),
    );
    output_id(&message_id(&env), index)
}

fn issue(issuer: &SigningKey, owner: Owner, amount: u64, caveats: Caveats) -> Signed<Issue> {
    issue_on(issuer, owner, amount, caveats, USDC)
}

fn issue_on(
    issuer: &SigningKey,
    owner: Owner,
    amount: u64,
    caveats: Caveats,
    mint: [u8; 32],
) -> Signed<Issue> {
    let mut issuer_key = [0; 33];
    issuer_key.copy_from_slice(issuer.verifying_key().to_sec1_point(true).as_bytes());
    // The issuer changes the salt until the issue's output is recordable.
    (0u8..)
        .map(|salt| {
            let message = Issue {
                issuer: issuer_key,
                mint,
                lock_seq: 0,
                cum_end: amount,
                salt: [salt; 16],
                owner,
                amount,
                caveats,
            };
            let env = envelope(
                &note_domain(),
                &message.slot().unwrap(),
                &content(&message.body()),
            );
            Signed {
                message,
                signature: sign(issuer, &env),
            }
        })
        .find(|issue| recordable(&issued_id(issue)))
        .unwrap()
}

fn recordable(id: &[u8; 32]) -> bool {
    record::recordable(&PROGRAM, id)
}

/// The signer changes the salt until every output of the spend is recordable, whoever owns it:
/// the attack tests spend those outputs again.
fn spend(holder: &SigningKey, input: &[u8; 32], lock_seq: u32, outputs: Outputs) -> Signed<Spend> {
    (0u8..)
        .map(|n| {
            let message = Spend {
                input: *input,
                lock_seq,
                salt: [0x77u8.wrapping_add(n); 16],
                outputs,
            };
            let env = envelope(&note_domain(), input, &message.content());
            Signed {
                message,
                signature: sign(holder, &env),
            }
        })
        .find(|spend| {
            let two = matches!(spend.message.outputs, Outputs::Two { .. });
            recordable(&spent_id(spend, 0)) && (!two || recordable(&spent_id(spend, 1)))
        })
        .unwrap()
}

fn attester() -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[11; 32])
}

fn ticket(device: &Owner, mint: [u8; 32], backing: u64) -> BondTicket {
    bonded(device, mint, min_bond(backing).unwrap(), backing)
}

fn bonded(device: &Owner, mint: [u8; 32], bond: u64, backing: u64) -> BondTicket {
    let mut ticket = BondTicket {
        device: device.encode(),
        mint,
        lock_seq: 0,
        bond,
        backing,
        lock_until: EXPIRY + GRACE + CHALLENGE + 1,
        valid_until: NOW + 86_400,
        attester: 1,
        signature: [0; 64],
    };
    ticket.signature = attester()
        .sign(&ticket.signed_message(&ticket_domain()))
        .to_bytes();
    ticket
}

fn attesters() -> [Attester; 1] {
    [Attester {
        id: 1,
        key: attester().verifying_key().to_bytes(),
    }]
}

fn receiver<'a>(attesters: &'a [Attester], me: &Owner) -> Receiver<'a> {
    Receiver {
        note_domain: note_domain(),
        program: PROGRAM,
        ticket_domain: ticket_domain(),
        attesters,
        me: *me,
        now: NOW,
        min_window: 86_400,
        accept_category: false,
        accept_authorities: &[],
    }
}

fn pay(
    me: &Owner,
    issue: &Signed<Issue>,
    spends: &[Signed<Spend>],
    tickets: &[BondTicket],
) -> Result<u64, ProtocolError> {
    pay_trusting(me, &[], issue, spends, tickets)
}

fn pay_trusting(
    me: &Owner,
    accept_authorities: &[[u8; 32]],
    issue: &Signed<Issue>,
    spends: &[Signed<Spend>],
    tickets: &[BondTicket],
) -> Result<u64, ProtocolError> {
    let attesters = attesters();
    let receiver = Receiver {
        accept_authorities,
        ..receiver(&attesters, me)
    };
    verify_payment(&receiver, issue, spends, tickets).map(|received| received.output.amount)
}

#[test]
fn no_lock_spend_of_an_undelegated_output_is_rejected() {
    let (issuer, issuer_key) = key(1);
    let (alice, alice_key) = key(2);
    let (_, bob) = key(3);
    let issued = issue(&issuer, alice_key, 100, caveats(4, 0, EXPIRY));
    let first = issued_id(&issued);
    let free_ride = spend(
        &alice,
        &first,
        NO_LOCK,
        Outputs::One {
            owner: bob,
            caveats: caveats(3, 0, EXPIRY),
        },
    );
    assert_eq!(
        pay(
            &bob,
            &issued,
            &[free_ride],
            &[ticket(&issuer_key, USDC, 100)]
        ),
        Err(ProtocolError::Lock)
    );
}

#[test]
fn authority_only_note_cannot_reach_anyone_but_the_authority() {
    let (issuer, issuer_key) = key(1);
    let (alice, alice_key) = key(2);
    let (_, carol) = key(4);
    let (_, dave) = key(6);
    let tickets = [ticket(&issuer_key, USDC, 100)];
    let unscoped = issue(
        &issuer,
        alice_key,
        100,
        caveats(4, flags::AUTHORITY_ONLY, EXPIRY),
    );
    assert_eq!(
        pay(&alice_key, &unscoped, &[], &tickets),
        Err(ProtocolError::Scope)
    );
    let redeemable = Caveats {
        scope_kind: ScopeKind::Authority,
        scope: ORGANISER.scope_hash(),
        ..caveats(4, flags::AUTHORITY_ONLY, EXPIRY)
    };
    let issued = issue(&issuer, alice_key, 100, redeemable);
    assert_eq!(
        pay(&alice_key, &issued, &[], &tickets),
        Err(ProtocolError::Scope)
    );
    let first = issued_id(&issued);
    let child = Caveats {
        hops_left: 3,
        expiry: EXPIRY - EXPIRY_STEP,
        ..redeemable
    };
    let to_carol = spend(
        &alice,
        &first,
        NO_LOCK,
        Outputs::One {
            owner: carol,
            caveats: child,
        },
    );
    assert_eq!(
        pay(&carol, &issued, &[to_carol], &tickets),
        Err(ProtocolError::Scope)
    );
    let change_to_dave = spend(
        &alice,
        &first,
        NO_LOCK,
        Outputs::Two {
            owner0: ORGANISER,
            amount0: 1,
            caveats0: child,
            owner1: dave,
        },
    );
    assert_eq!(
        pay(&ORGANISER, &issued, &[change_to_dave], &tickets),
        Err(ProtocolError::Change)
    );
    let redeemed = spend(
        &alice,
        &first,
        NO_LOCK,
        Outputs::Two {
            owner0: ORGANISER,
            amount0: 1,
            caveats0: child,
            owner1: alice_key,
        },
    );
    assert_eq!(pay(&ORGANISER, &issued, &[redeemed], &tickets), Ok(1));
}

#[test]
fn delegation_cannot_escape_through_change_or_an_unlocked_spend() {
    let (issuer, issuer_key) = key(1);
    let (alice, alice_key) = key(2);
    let (_, sybil) = key(7);
    let (_, x) = key(8);
    let issued = issue(
        &issuer,
        alice_key,
        100,
        caveats(4, flags::DELEGATED, EXPIRY),
    );
    let first = issued_id(&issued);
    let to_sybil = spend(
        &alice,
        &first,
        NO_LOCK,
        Outputs::Two {
            owner0: x,
            amount0: 1,
            caveats0: caveats(3, 0, EXPIRY),
            owner1: sybil,
        },
    );
    let tickets = [ticket(&issuer_key, USDC, 100)];
    assert_eq!(
        pay(&x, &issued, &[to_sybil], &tickets),
        Err(ProtocolError::Change)
    );
    let redelegated = spend(
        &alice,
        &first,
        NO_LOCK,
        Outputs::One {
            owner: x,
            caveats: caveats(3, flags::DELEGATED, EXPIRY),
        },
    );
    assert_eq!(
        pay(&x, &issued, &[redelegated], &tickets),
        Err(ProtocolError::Lock)
    );
}

#[test]
fn already_expired_outputs_are_refused() {
    let (issuer, issuer_key) = key(1);
    let (alice, alice_key) = key(2);
    let (_, bob) = key(3);
    let tickets = [
        ticket(&issuer_key, USDC, 200),
        ticket(&alice_key, USDC, 200),
    ];
    let stale = issue(&issuer, alice_key, 100, caveats(4, 0, 1_000));
    assert_eq!(
        pay(&alice_key, &stale, &[], &tickets[..1]),
        Err(ProtocolError::Window)
    );
    let issued = issue(&issuer, alice_key, 100, caveats(4, 0, EXPIRY));
    let first = issued_id(&issued);
    let expired = spend(
        &alice,
        &first,
        0,
        Outputs::One {
            owner: bob,
            caveats: caveats(3, 0, 1),
        },
    );
    assert_eq!(
        pay(&bob, &issued, &[expired], &tickets),
        Err(ProtocolError::Window)
    );
}

#[test]
fn unbacked_issue_is_refused() {
    let (issuer, issuer_key) = key(1);
    let (_, alice_key) = key(2);
    let issued = issue(&issuer, alice_key, u64::MAX, caveats(16, 0, EXPIRY));
    assert_eq!(
        pay(&alice_key, &issued, &[], &[]),
        Err(ProtocolError::Ticket)
    );
    assert_eq!(
        pay(&alice_key, &issued, &[], &[ticket(&issuer_key, USDC, 100)]),
        Err(ProtocolError::Ticket)
    );
}

#[test]
fn verification_rechecks_decoder_invariants() {
    let (issuer, _) = key(1);
    let (_, alice_key) = key(2);
    let zero = issue(&issuer, alice_key, 0, caveats(4, 0, EXPIRY));
    assert_eq!(pay(&alice_key, &zero, &[], &[]), Err(ProtocolError::Amount));
    let deep = issue(&issuer, alice_key, 100, caveats(200, 0, EXPIRY));
    assert_eq!(pay(&alice_key, &deep, &[], &[]), Err(ProtocolError::Depth));
}

#[test]
fn signature_under_another_purpose_cannot_frame_a_spender() {
    let (issuer, _) = key(1);
    let (alice, alice_key) = key(2);
    let (_, bob) = key(3);
    let Owner::Device(alice_public) = alice_key else {
        unreachable!()
    };
    let issued = issue(&issuer, alice_key, 100, caveats(4, 0, EXPIRY));
    let first = issued_id(&issued);
    let honest = spend(
        &alice,
        &first,
        0,
        Outputs::One {
            owner: bob,
            caveats: caveats(3, 0, EXPIRY),
        },
    );
    let foreign = content(&[0x30; 50]);
    let witness = envelope(
        &domain(purpose::WITNESS, &GENESIS, &PROGRAM),
        &first,
        &foreign,
    );
    let witness_signature = sign(&alice, &witness);
    let framed = SpendConflict {
        slot: first,
        content_a: honest.message.content(),
        signature_a: honest.signature,
        content_b: foreign,
        signature_b: witness_signature,
        recovery: 0,
    };
    assert_eq!(
        verify_spend_conflict(&note_domain(), &alice_public, &framed),
        Err(ProtocolError::Signature)
    );
}

#[test]
fn issue_on_a_lock_of_another_mint_is_refused() {
    let (issuer, issuer_key) = key(1);
    let (_, alice_key) = key(2);
    let Owner::Device(issuer_public) = issuer_key else {
        unreachable!()
    };
    let usdc = issue(&issuer, alice_key, 100, caveats(4, 0, EXPIRY));
    let usdt = issue_on(&issuer, alice_key, 100, caveats(4, 0, EXPIRY), [4; 32]);
    let lock = [ticket(&issuer_key, USDC, 100)];
    assert_eq!(pay(&alice_key, &usdc, &[], &lock), Ok(100));
    assert_eq!(
        pay(&alice_key, &usdt, &[], &lock),
        Err(ProtocolError::Ticket)
    );
    let claim = |signed: &Signed<Issue>| {
        let (start, end) = signed.message.interval().unwrap();
        IssueClaim {
            lock_seq: 0,
            start,
            end,
            content: content(&signed.message.body()),
            signature: signed.signature,
        }
    };
    let reused_lock = IssueConflict {
        a: claim(&usdc),
        b: claim(&usdt),
        recovery: 0,
    };
    assert_eq!(
        verify_issue_conflict(&note_domain(), &issuer_public, &reused_lock),
        Ok(())
    );
}

#[test]
fn spend_content_resists_dictionary_guessing() {
    let (alice, _) = key(2);
    let candidates: Vec<Owner> = (10..250u8).map(|seed| key(seed).1).collect();
    let input = [0x42; 32];
    let paid = spend(
        &alice,
        &input,
        0,
        Outputs::One {
            owner: candidates[137],
            caveats: caveats(3, 0, EXPIRY),
        },
    );
    let published = paid.message.content();
    let guessed = candidates.iter().any(|owner| {
        (0..4u32).any(|lock_seq| {
            (0..=16u8).any(|hops| {
                let guess = Spend {
                    input,
                    lock_seq,
                    salt: [0; 16],
                    outputs: Outputs::One {
                        owner: *owner,
                        caveats: caveats(hops, 0, EXPIRY),
                    },
                };
                guess.content() == published
            })
        })
    });
    assert!(!guessed);
}

#[test]
fn decoders_never_panic_on_any_length() {
    let mut x: u64 = 0x1234_5678;
    for len in 0..300usize {
        for _ in 0..50 {
            let random: Vec<u8> = (0..len)
                .map(|_| {
                    x ^= x << 13;
                    x ^= x >> 7;
                    x ^= x << 17;
                    x as u8
                })
                .collect();
            let mut framed = random.clone();
            if framed.len() > 1 {
                framed[0] = 1;
                framed[1] = [1, 2, 3, 0x10, 0x20, 0x21][(x % 6) as usize];
            }
            for bytes in [&random, &framed] {
                let _ = Signed::<Issue>::decode(bytes);
                let _ = Signed::<Spend>::decode(bytes);
                let _ = BondTicket::decode(bytes);
                let _ = SpendConflict::decode(bytes);
                let _ = IssueConflict::decode(bytes);
                let _ = Spend::decode([0; 32], bytes);
                let _ = Issue::decode_body(bytes);
            }
        }
    }
}

#[test]
fn zero_hop_output_that_can_never_settle_is_refused() {
    let (issuer, issuer_key) = key(1);
    let (alice, alice_key) = key(2);
    let (_, merchant) = key(3);
    let issued = issue(&issuer, alice_key, 100, caveats(4, 0, EXPIRY));
    let first = issued_id(&issued);
    let dead_end = spend(
        &alice,
        &first,
        0,
        Outputs::One {
            owner: merchant,
            caveats: caveats(0, 0, EXPIRY),
        },
    );
    let tickets = [
        ticket(&issuer_key, USDC, 100),
        ticket(&alice_key, USDC, 100),
    ];
    assert_eq!(
        pay(&merchant, &issued, &[dead_end], &tickets),
        Err(ProtocolError::Window)
    );
}

#[test]
fn issuer_bond_must_cover_each_issue() {
    let (issuer, issuer_key) = key(1);
    let (_, first_merchant) = key(20);
    let (_, second_merchant) = key(21);
    let unbonded = [bonded(&issuer_key, USDC, 0, 100)];
    let bonded_lock = [ticket(&issuer_key, USDC, 100)];
    for merchant in [first_merchant, second_merchant] {
        let issued = issue(&issuer, merchant, 100, caveats(4, 0, EXPIRY));
        assert_eq!(
            pay(&merchant, &issued, &[], &unbonded),
            Err(ProtocolError::Ticket)
        );
        assert_eq!(pay(&merchant, &issued, &[], &bonded_lock), Ok(100));
    }
}

#[test]
fn delegated_issue_is_the_issuer_bond_liability() {
    let (issuer, issuer_key) = key(1);
    let (alice, alice_key) = key(2);
    let (_, bob) = key(3);
    let issued = issue(
        &issuer,
        alice_key,
        100,
        caveats(4, flags::DELEGATED, EXPIRY),
    );
    let to_bob = spend(
        &alice,
        &issued_id(&issued),
        NO_LOCK,
        Outputs::One {
            owner: bob,
            caveats: caveats(3, 0, EXPIRY),
        },
    );
    assert_eq!(
        pay(
            &bob,
            &issued,
            &[to_bob],
            &[bonded(&issuer_key, USDC, min_bond(100).unwrap() - 1, 100)]
        ),
        Err(ProtocolError::Ticket)
    );
    assert_eq!(
        pay(&bob, &issued, &[to_bob], &[ticket(&issuer_key, USDC, 100)]),
        Ok(100)
    );
}

#[test]
fn scoped_note_settles_once_it_reaches_its_party() {
    let (issuer, issuer_key) = key(1);
    let (alice, alice_key) = key(2);
    let (merchant, merchant_key) = key(3);
    let merchant_account = Owner::Account([0xb5; 32]);
    let scope = Caveats {
        scope_kind: ScopeKind::Merchant,
        scope: merchant_key.scope_hash(),
        ..caveats(4, 0, EXPIRY)
    };
    let issued = issue(&issuer, alice_key, 100, scope);
    let to_merchant = spend(
        &alice,
        &issued_id(&issued),
        0,
        Outputs::One {
            owner: merchant_key,
            caveats: Caveats {
                hops_left: 3,
                expiry: EXPIRY - EXPIRY_STEP,
                ..scope
            },
        },
    );
    let settle = spend(
        &merchant,
        &spent_id(&to_merchant, 0),
        0,
        Outputs::One {
            owner: merchant_account,
            caveats: caveats(2, 0, EXPIRY),
        },
    );
    let chain = [to_merchant, settle];
    let tickets = [
        ticket(&issuer_key, USDC, 100),
        ticket(&alice_key, USDC, 100),
        ticket(&merchant_key, USDC, 100),
    ];
    assert_eq!(pay(&merchant_account, &issued, &chain, &tickets), Ok(100));
    let settled = verify_settlement(&note_domain(), &PROGRAM, &issued, &chain).unwrap();
    assert_eq!(settled.output.owner, merchant_account);
    assert_eq!(settled.output.amount, 100);
    assert_eq!(
        verify_settlement(&note_domain(), &PROGRAM, &issued, &chain[..1]),
        Err(ProtocolError::Payee)
    );
}

#[test]
fn authority_is_paid_in_a_terminal_output() {
    let (issuer, issuer_key) = key(1);
    let (alice, alice_key) = key(2);
    let redeemable = Caveats {
        scope_kind: ScopeKind::Authority,
        scope: ORGANISER.scope_hash(),
        ..caveats(4, flags::AUTHORITY_ONLY, EXPIRY)
    };
    let issued = issue(&issuer, alice_key, 100, redeemable);
    let redeemed = spend(
        &alice,
        &issued_id(&issued),
        NO_LOCK,
        Outputs::One {
            owner: ORGANISER,
            caveats: Caveats {
                hops_left: 0,
                ..redeemable
            },
        },
    );
    let tickets = [ticket(&issuer_key, USDC, 100)];
    assert_eq!(pay(&ORGANISER, &issued, &[redeemed], &tickets), Ok(100));
    let settled = verify_settlement(&note_domain(), &PROGRAM, &issued, &[redeemed]).unwrap();
    assert_eq!(settled.output.owner, ORGANISER);
}

#[test]
fn own_change_is_not_a_payment() {
    let (issuer, issuer_key) = key(1);
    let (alice, alice_key) = key(2);
    let (_, bob) = key(3);
    let issued = issue(&issuer, alice_key, 100, caveats(4, 0, EXPIRY));
    let to_bob = spend(
        &alice,
        &issued_id(&issued),
        0,
        Outputs::Two {
            owner0: bob,
            amount0: 1,
            caveats0: caveats(3, 0, EXPIRY),
            owner1: alice_key,
        },
    );
    let tickets = [
        ticket(&issuer_key, USDC, 100),
        ticket(&alice_key, USDC, 100),
    ];
    assert_eq!(
        pay(&alice_key, &issued, &[to_bob], &tickets),
        Err(ProtocolError::Payee)
    );
    assert_eq!(pay(&bob, &issued, &[to_bob], &tickets), Ok(1));
}

#[test]
fn change_that_could_never_move_is_refused() {
    let (issuer, issuer_key) = key(1);
    let (alice, alice_key) = key(2);
    let issued = issue(&issuer, alice_key, 100, caveats(1, 0, EXPIRY));
    let last_hop = spend(
        &alice,
        &issued_id(&issued),
        0,
        Outputs::Two {
            owner0: ORGANISER,
            amount0: 10,
            caveats0: caveats(0, 0, EXPIRY),
            owner1: alice_key,
        },
    );
    let tickets = [
        ticket(&issuer_key, USDC, 100),
        ticket(&alice_key, USDC, 100),
    ];
    assert_eq!(
        pay(&ORGANISER, &issued, &[last_hop], &tickets),
        Err(ProtocolError::Depth)
    );
}

#[test]
fn a_bad_ticket_cannot_hide_a_good_one() {
    let (issuer, issuer_key) = key(1);
    let (alice, alice_key) = key(2);
    let (_, bob) = key(3);
    let issued = issue(
        &issuer,
        alice_key,
        100,
        caveats(4, flags::DELEGATED, EXPIRY),
    );
    let to_bob = spend(
        &alice,
        &issued_id(&issued),
        NO_LOCK,
        Outputs::One {
            owner: bob,
            caveats: caveats(3, 0, EXPIRY),
        },
    );
    let junk = BondTicket {
        signature: [0; 64],
        ..ticket(&alice_key, USDC, 100)
    };
    assert_eq!(
        pay(
            &bob,
            &issued,
            &[to_bob],
            &[junk, ticket(&issuer_key, USDC, 100)]
        ),
        Ok(100)
    );
}

#[test]
fn a_payment_carries_one_ticket_per_lock_at_most_one_per_message() {
    let (issuer, issuer_key) = key(1);
    let (alice, alice_key) = key(2);
    let (_, bob) = key(3);
    let issued = issue(&issuer, alice_key, 100, caveats(4, 0, EXPIRY));
    let good = ticket(&issuer_key, USDC, 100);
    assert_eq!(pay(&alice_key, &issued, &[], &[good]), Ok(100));
    assert_eq!(
        pay(
            &alice_key,
            &issued,
            &[],
            &[good, ticket(&alice_key, USDC, 100)]
        ),
        Err(ProtocolError::Ticket)
    );
    let flood = vec![good; 10_000];
    assert_eq!(
        pay(&alice_key, &issued, &[], &flood),
        Err(ProtocolError::Ticket)
    );
    let to_bob = spend(
        &alice,
        &issued_id(&issued),
        0,
        Outputs::One {
            owner: bob,
            caveats: caveats(3, 0, EXPIRY),
        },
    );
    let unsigned = BondTicket {
        signature: [0; 64],
        ..good
    };
    assert_eq!(
        pay(&bob, &issued, &[to_bob], &[unsigned, good]),
        Err(ProtocolError::Ticket)
    );
    assert_eq!(
        pay(&bob, &issued, &vec![to_bob; 17], &[]),
        Err(ProtocolError::Depth)
    );
}

#[test]
fn a_payment_the_receiver_cannot_redeem_is_refused() {
    let (issuer, issuer_key) = key(1);
    let (alice, alice_key) = key(2);
    let (_, bob) = key(3);
    let (_, carol) = key(4);
    let issued = issue(&issuer, alice_key, 100, caveats(4, 0, EXPIRY));
    let first = issued_id(&issued);
    let scoped = |scope_kind, scope| {
        let caveats = Caveats {
            scope_kind,
            scope,
            ..caveats(3, 0, EXPIRY)
        };
        spend(
            &alice,
            &first,
            0,
            Outputs::One {
                owner: bob,
                caveats,
            },
        )
    };
    let tickets = [
        ticket(&issuer_key, USDC, 100),
        ticket(&alice_key, USDC, 100),
    ];
    for foreign in [
        scoped(ScopeKind::Merchant, carol.scope_hash()),
        scoped(ScopeKind::Authority, ORGANISER.scope_hash()),
    ] {
        assert_eq!(
            pay(&bob, &issued, &[foreign], &tickets),
            Err(ProtocolError::Scope)
        );
    }
    let own = scoped(ScopeKind::Merchant, bob.scope_hash());
    assert_eq!(pay(&bob, &issued, &[own], &tickets), Ok(100));
    let mut code = [0; 20];
    code[..2].copy_from_slice(&7u16.to_le_bytes());
    let category = scoped(ScopeKind::Category, code);
    assert_eq!(
        pay(&bob, &issued, &[category], &tickets),
        Err(ProtocolError::Scope)
    );
    let attesters = attesters();
    let opted_in = Receiver {
        accept_category: true,
        ..receiver(&attesters, &bob)
    };
    assert_eq!(
        verify_payment(&opted_in, &issued, &[category], &tickets).map(|r| r.output.amount),
        Ok(100)
    );
}

#[test]
fn authority_only_cannot_be_added_after_the_issue() {
    let (issuer, issuer_key) = key(1);
    let (alice, alice_key) = key(2);
    let (sybil, sybil_key) = key(7);
    let issued = issue(&issuer, alice_key, 100, caveats(4, 0, EXPIRY));
    let closed = Caveats {
        scope_kind: ScopeKind::Authority,
        scope: ORGANISER.scope_hash(),
        ..caveats(3, flags::AUTHORITY_ONLY, EXPIRY)
    };
    let to_sybil = spend(
        &alice,
        &issued_id(&issued),
        0,
        Outputs::One {
            owner: sybil_key,
            caveats: closed,
        },
    );
    let unbonded = spend(
        &sybil,
        &spent_id(&to_sybil, 0),
        NO_LOCK,
        Outputs::One {
            owner: ORGANISER,
            caveats: Caveats {
                hops_left: 2,
                ..closed
            },
        },
    );
    let tickets = [
        ticket(&issuer_key, USDC, 100),
        ticket(&alice_key, USDC, 100),
    ];
    assert_eq!(
        pay(&ORGANISER, &issued, &[to_sybil, unbonded], &tickets),
        Err(ProtocolError::Attenuation)
    );
}

#[test]
fn a_device_can_never_be_the_authority() {
    let (issuer, issuer_key) = key(1);
    let (alice, alice_key) = key(2);
    let (pretender, pretender_key) = key(3);
    let (_, x) = key(8);
    let closed = Caveats {
        scope_kind: ScopeKind::Authority,
        scope: pretender_key.scope_hash(),
        ..caveats(4, flags::AUTHORITY_ONLY | flags::DELEGATED, EXPIRY)
    };
    let tickets = [
        ticket(&issuer_key, USDC, 100),
        ticket(&pretender_key, USDC, 100),
    ];
    let direct = issue(&issuer, pretender_key, 100, closed);
    assert_eq!(
        pay(&pretender_key, &direct, &[], &tickets[..1]),
        Err(ProtocolError::Scope)
    );
    let issued = issue(&issuer, alice_key, 100, closed);
    let to_pretender = spend(
        &alice,
        &issued_id(&issued),
        NO_LOCK,
        Outputs::One {
            owner: pretender_key,
            caveats: Caveats {
                hops_left: 3,
                flags: flags::AUTHORITY_ONLY,
                ..closed
            },
        },
    );
    let escape = spend(
        &pretender,
        &spent_id(&to_pretender, 0),
        0,
        Outputs::One {
            owner: x,
            caveats: caveats(2, 0, EXPIRY),
        },
    );
    assert_eq!(
        pay(&x, &issued, &[to_pretender, escape], &tickets),
        Err(ProtocolError::Scope)
    );
}

#[test]
fn a_closed_circuit_attendee_accepts_only_trusted_authorities() {
    let (issuer, issuer_key) = key(1);
    let (alice, alice_key) = key(2);
    let (_, bob) = key(3);
    let elsewhere_address = [0xb0; 32];
    let elsewhere = Owner::Account(elsewhere_address);
    let closed = Caveats {
        scope_kind: ScopeKind::Authority,
        scope: ORGANISER.scope_hash(),
        ..caveats(4, flags::AUTHORITY_ONLY, EXPIRY)
    };
    let tickets = [ticket(&issuer_key, USDC, 100)];
    let issued = issue(&issuer, alice_key, 100, closed);
    assert_eq!(
        pay(&alice_key, &issued, &[], &tickets),
        Err(ProtocolError::Scope)
    );
    assert_eq!(
        pay_trusting(&alice_key, &[elsewhere_address], &issued, &[], &tickets),
        Err(ProtocolError::Scope)
    );
    assert_eq!(
        pay_trusting(
            &alice_key,
            &[elsewhere_address, ORGANISER_ADDRESS],
            &issued,
            &[],
            &tickets
        ),
        Ok(100)
    );
    let unflagged = issue(&issuer, alice_key, 100, Caveats { flags: 0, ..closed });
    assert_eq!(
        pay_trusting(&alice_key, &[ORGANISER_ADDRESS], &unflagged, &[], &tickets),
        Err(ProtocolError::Scope)
    );
    let to_account = issue(&issuer, elsewhere, 100, closed);
    assert_eq!(
        pay_trusting(&elsewhere, &[ORGANISER_ADDRESS], &to_account, &[], &tickets),
        Err(ProtocolError::Scope)
    );
    let hand_on = |owner| {
        spend(
            &alice,
            &issued_id(&issued),
            NO_LOCK,
            Outputs::One {
                owner,
                caveats: Caveats {
                    hops_left: 3,
                    expiry: EXPIRY - EXPIRY_STEP,
                    ..closed
                },
            },
        )
    };
    assert_eq!(
        pay_trusting(
            &bob,
            &[ORGANISER_ADDRESS],
            &issued,
            &[hand_on(bob)],
            &tickets
        ),
        Err(ProtocolError::Scope)
    );
    assert_eq!(
        pay(&ORGANISER, &issued, &[hand_on(ORGANISER)], &tickets),
        Ok(100)
    );
}

#[test]
fn a_payment_names_every_lock_liable_for_it() {
    let (issuer, issuer_key) = key(1);
    let (alice, alice_key) = key(2);
    let (bob, bob_key) = key(3);
    let (_, carol) = key(4);
    let issued = issue(&issuer, alice_key, 100, caveats(4, 0, EXPIRY));
    let delegation = spend(
        &alice,
        &issued_id(&issued),
        0,
        Outputs::Two {
            owner0: bob_key,
            amount0: 60,
            caveats0: caveats(3, flags::DELEGATED, EXPIRY),
            owner1: alice_key,
        },
    );
    let delegated = spend(
        &bob,
        &spent_id(&delegation, 0),
        NO_LOCK,
        Outputs::One {
            owner: carol,
            caveats: caveats(2, 0, EXPIRY),
        },
    );
    let from_change = spend(
        &alice,
        &spent_id(&delegation, 1),
        0,
        Outputs::One {
            owner: carol,
            caveats: caveats(2, 0, EXPIRY),
        },
    );
    let tickets = [
        bonded(&issuer_key, USDC, 400, 100),
        bonded(&alice_key, USDC, 400, 0),
    ];
    let lock = |device: &Owner, bond| Liability {
        device: device.encode(),
        lock_seq: 0,
        bond,
    };
    let attesters = attesters();
    for (last, amount) in [(delegated, 60), (from_change, 40)] {
        let received = verify_payment(
            &receiver(&attesters, &carol),
            &issued,
            &[delegation, last],
            &tickets,
        )
        .unwrap();
        assert_eq!(received.output.amount, amount);
        assert_eq!(
            *received.liable,
            [lock(&issuer_key, 400), lock(&alice_key, 400)]
        );
    }
}

#[test]
fn settlement_ignores_time() {
    let (issuer, _) = key(1);
    let expired = issue(&issuer, ORGANISER, 100, caveats(0, 0, 1_000));
    // The program, not the chain rules, bounds settlement by `expiry + GRACE`.
    let settled = verify_settlement(&note_domain(), &PROGRAM, &expired, &[]).unwrap();
    assert_eq!(settled.output.amount, 100);
}

#[test]
fn a_trust_list_names_accounts_never_devices() {
    let (issuer, issuer_key) = key(1);
    let (_, alice_key) = key(2);
    let (_, bob) = key(3);
    let scoped_to_bob = Caveats {
        scope_kind: ScopeKind::Authority,
        scope: bob.scope_hash(),
        ..caveats(4, flags::AUTHORITY_ONLY, EXPIRY)
    };
    let issued = issue(&issuer, alice_key, 100, scoped_to_bob);
    let tickets = [ticket(&issuer_key, USDC, 100)];
    let device = bob.encode();
    let (mut head, mut tail) = ([0; 32], [0; 32]);
    head.copy_from_slice(&device[..32]);
    tail.copy_from_slice(&device[1..]);
    assert_eq!(
        pay_trusting(&alice_key, &[head, tail], &issued, &[], &tickets),
        Err(ProtocolError::Scope)
    );
}

#[test]
fn an_unbonded_receiver_settles_what_it_accepted() {
    let (issuer, issuer_key) = key(1);
    let (alice, alice_key) = key(2);
    let (bob, bob_key) = key(3);
    let bob_account = Owner::Account([0xb5; 32]);
    let issued = issue(&issuer, alice_key, 100, caveats(4, 0, EXPIRY));
    let to_bob = spend(
        &alice,
        &issued_id(&issued),
        0,
        Outputs::One {
            owner: bob_key,
            caveats: caveats(3, 0, EXPIRY),
        },
    );
    let tickets = [
        ticket(&issuer_key, USDC, 100),
        ticket(&alice_key, USDC, 100),
    ];
    assert_eq!(pay(&bob_key, &issued, &[to_bob], &tickets), Ok(100));
    let settle = |outputs| spend(&bob, &spent_id(&to_bob, 0), NO_LOCK, outputs);
    let chain = [
        to_bob,
        settle(Outputs::One {
            owner: bob_account,
            caveats: caveats(2, 0, EXPIRY),
        }),
    ];
    let settled = verify_settlement(&note_domain(), &PROGRAM, &issued, &chain).unwrap();
    assert_eq!(settled.output.owner, bob_account);
    assert_eq!(settled.output.amount, 100);
    assert_eq!(
        pay(&bob_account, &issued, &chain, &tickets),
        Err(ProtocolError::Lock)
    );
    let split = settle(Outputs::Two {
        owner0: bob_account,
        amount0: 60,
        caveats0: caveats(2, 0, EXPIRY),
        owner1: bob_key,
    });
    assert_eq!(
        verify_settlement(&note_domain(), &PROGRAM, &issued, &[to_bob, split]),
        Err(ProtocolError::Lock)
    );
}
