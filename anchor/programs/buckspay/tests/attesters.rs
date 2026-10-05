mod common;
use anchor_lang::{prelude::Pubkey, solana_program::system_instruction, Space};
use buckspay::{
    state::{attester_status, Attester, Ledger, ATTESTER_LEDGER_MARKER, ATTESTER_SEED},
    BuckspayError as E,
};
use buckspay_protocol::{
    attest::{EXIT_DELAY, MIN_STAKE_TOKENS},
    lock::{RECORD_TTL, TICKET_TTL_MAX},
};
use common::attesters::*;
use common::claims::constraint;
use common::*;
use curve25519_dalek::{
    constants::EIGHT_TORSION,
    edwards::{CompressedEdwardsY, EdwardsPoint},
};
use ed25519_dalek::Signer as _;
use solana_keypair::Keypair;
use solana_signer::Signer;

const DAY: u32 = 86_400;
const MIN_STAKE: u64 = MIN_STAKE_TOKENS * 1_000_000;

fn env() -> Env {
    Env::new(TokenKind::Classic)
}

/// A registered attester, a registered user with a lock, and the ticket an honest attester signs
/// for it.
fn scene() -> (Env, Operator, User, Lock) {
    let mut env = env();
    let operator = env.registered(1, 11, STAKE);
    let user = env.user(2_000_000_000);
    let lock = lock_for(&mut env, &user, 400_000_000, 1_000_000_000, MIN_LOCK + DAY);
    (env, operator, user, lock)
}

fn report(
    env: &mut Env,
    operator: &Operator,
    ticket: &buckspay_protocol::BondTicket,
) -> Result<(), TransactionError> {
    let reporter = env.funded_keypair();
    env.send(
        &reporter,
        &report_ixs(env, &reporter.pubkey(), ticket, &operator.public()),
    )
    .map(drop)
}

fn bump(seeds: &[&[u8]]) -> u8 {
    Pubkey::find_program_address(seeds, &buckspay::ID).1
}

// Registration

#[test]
fn an_attester_registers_with_its_stake_and_a_canonical_key() {
    let mut env = env();
    let op = env.operator(1, 11);
    let before = env.balance(&op.token);
    env.register_attester(&op, &op.public(), STAKE).unwrap();

    let a = env.attester(&op.address);
    assert_eq!(
        (
            a.id,
            a.authority,
            a.mint,
            a.key,
            a.prev_key,
            a.prev_trusted_until,
            a.prev_until
        ),
        (
            1,
            op.authority.pubkey(),
            env.mint,
            op.public(),
            [0; 32],
            0,
            0
        )
    );
    assert_eq!(
        (a.registered_at, a.status, a.exit_at),
        (env.now(), attester_status::ACTIVE, 0)
    );
    let ledger = env.ledger(&op.address);
    assert_eq!(
        (ledger.backing_left, ledger.bond_free, ledger.bond_slashed),
        (0, STAKE, 0)
    );
    assert_eq!(ledger.key[0], ATTESTER_LEDGER_MARKER);
    assert_eq!(ledger.key[1..3], 1u16.to_le_bytes());
    assert_eq!((ledger.lock_seq, ledger.payer), (1, op.authority.pubkey()));
    assert_eq!(env.balance(&op.escrow()), STAKE);
    assert_eq!(before - env.balance(&op.token), STAKE);
}

#[test]
fn registration_refuses_keys_that_are_not_canonical_prime_order_points() {
    let honest = signing(11).verifying_key().to_edwards();
    let compressed = |p: EdwardsPoint| p.compress().to_bytes();
    // y = p + 1 is the identity written with a y that is not reduced.
    let mut non_canonical = [0xff; 32];
    non_canonical[0] = 0xee;
    non_canonical[31] = 0x7f;
    let off_curve = (2u8..)
        .map(|b| [b; 32])
        .find(|bytes| CompressedEdwardsY(*bytes).decompress().is_none())
        .unwrap();
    let mut refused: Vec<[u8; 32]> = EIGHT_TORSION.iter().map(|p| compressed(*p)).collect();
    refused.push(compressed(honest + EIGHT_TORSION[1]));
    refused.push(non_canonical);
    refused.push(off_curve);
    assert_eq!(refused.len(), 11);
    for key in refused {
        let mut env = env();
        let op = env.operator(1, 11);
        assert_eq!(
            env.register_attester(&op, &key, STAKE),
            Err(code(0, E::AttesterKey)),
            "{key:02x?}"
        );
        assert!(env.try_attester(&op.address).is_none());
    }
    let mut env = env();
    let op = env.operator(1, 11);
    env.register_attester(&op, &compressed(honest), STAKE)
        .unwrap();
}

#[test]
fn the_minimum_stake_is_a_hundred_whole_tokens() {
    let mut env = env();
    let op = env.operator(1, 11);
    assert_eq!(
        env.register_attester(&op, &op.public(), MIN_STAKE - 1),
        Err(code(0, E::StakeTooLow))
    );
    env.register_attester(&op, &op.public(), MIN_STAKE).unwrap();
}

#[test]
fn an_id_is_registered_once_and_never_again() {
    let mut env = env();
    let first = env.registered(7, 11, STAKE);
    let record = env.attester(&first.address);
    let mut second = env.operator(7, 12);
    second.address = first.address;
    assert!(env
        .register_attester(&second, &second.public(), STAKE)
        .is_err());
    assert_eq!(env.attester(&first.address), record);
}

#[test]
fn only_the_authority_changes_an_attester() {
    let mut env = env();
    let op = env.registered(1, 11, STAKE);
    let stranger = env.funded_keypair();
    let new_key = public(&signing(12));
    let fake = Operator {
        id: 1,
        authority: stranger.insecure_clone(),
        key: signing(12),
        token: op.token,
        address: op.address,
    };
    for ix in [
        request_exit_ix(&stranger.pubkey(), &op.address),
        cancel_exit_ix(&stranger.pubkey(), &op.address),
        rotate_ix(&fake, &new_key, true),
    ] {
        assert_eq!(env.send(&stranger, &[ix]), Err(constraint(0, 2001)));
    }
    assert_eq!(env.attester(&op.address).status, attester_status::ACTIVE);
}

#[test]
fn top_up_adds_to_the_free_stake_only_while_active() {
    let mut env = env();
    let op = env.registered(1, 11, STAKE);
    env.send_operator(&op, &[top_up_ix(&env, &op, STAKE)])
        .unwrap();
    assert_eq!(env.ledger(&op.address).bond_free, 2 * STAKE);
    assert_eq!(env.balance(&op.escrow()), 2 * STAKE);
    env.send_operator(&op, &[request_exit_ix(&op.authority.pubkey(), &op.address)])
        .unwrap();
    assert_eq!(
        env.send_operator(&op, &[top_up_ix(&env, &op, 1)]),
        Err(code(0, E::AttesterStatus))
    );
}

#[test]
fn a_lock_ledger_cannot_be_topped_up_and_an_attester_ledger_only_by_a_real_amount() {
    let mut lock = Ledger::new(100, 400, Pubkey::default(), [2; 33], 0, 255);
    let unchanged = Ledger::new(100, 400, Pubkey::default(), [2; 33], 0, 255);
    assert!(lock.add_stake(5).is_err());
    assert_eq!(lock, unchanged);

    let mut marker = [0; 33];
    marker[0] = ATTESTER_LEDGER_MARKER;
    let mut attester = Ledger::new(100, 0, Pubkey::default(), marker, 1, 255);
    attester.add_stake(5).unwrap();
    assert_eq!(attester.bond_free, 105);
    let before = Ledger::new(105, 0, Pubkey::default(), marker, 1, 255);
    assert!(attester.add_stake(0).is_err());
    assert!(attester.add_stake(u64::MAX).is_err());
    assert_eq!(attester, before);
}

// Rotation and exit

#[test]
fn rotation_keeps_the_old_key_accountable_and_waits_for_the_tail() {
    let mut env = env();
    let op = env.registered(1, 11, STAKE);
    let new_key = public(&signing(12));
    let start = env.now();
    env.send_operator(&op, &[rotate_ix(&op, &new_key, true)])
        .unwrap();
    let a = env.attester(&op.address);
    assert_eq!(
        (a.key, a.prev_key, a.prev_until, a.prev_trusted_until),
        (
            new_key,
            op.public(),
            start + EXIT_DELAY,
            start + TICKET_TTL_MAX
        )
    );
    let third = public(&signing(13));
    assert_eq!(
        env.send_operator(&op, &[rotate_ix(&op, &third, false)]),
        Err(code(0, E::RotationCooldown))
    );
    env.warp(i64::from(start + EXIT_DELAY));
    let mut identity = [0u8; 32];
    identity[0] = 1;
    for key in [new_key, identity] {
        assert_eq!(
            env.send_operator(&op, &[rotate_ix(&op, &key, false)]),
            Err(code(0, E::AttesterKey))
        );
    }
    env.send_operator(&op, &[rotate_ix(&op, &third, false)])
        .unwrap();
    let a = env.attester(&op.address);
    assert_eq!(
        (a.key, a.prev_key, a.prev_trusted_until),
        (third, new_key, 0)
    );
}

#[test]
fn leaving_waits_for_the_delay_and_returns_the_stake_and_the_rent() {
    let mut env = env();
    let op = env.registered(1, 11, STAKE);
    let destination = env.token_account_of(&Keypair::new().pubkey(), 0);
    let authority = op.authority.pubkey();
    let withdraw = |env: &mut Env| {
        let ix = withdraw_stake_ix(env, &op, &destination, &authority);
        let payer = env.payer.insecure_clone();
        env.send_signed(&payer.pubkey(), &[ix], &[&payer, &op.authority])
            .map(drop)
    };
    assert_eq!(withdraw(&mut env), Err(code(0, E::AttesterStatus)));
    env.send_operator(&op, &[request_exit_ix(&authority, &op.address)])
        .unwrap();
    let asked = env.now();
    env.warp(i64::from(asked + EXIT_DELAY - 1));
    assert_eq!(withdraw(&mut env), Err(code(0, E::ExitNotReady)));
    env.send_operator(&op, &[cancel_exit_ix(&authority, &op.address)])
        .unwrap();
    assert_eq!(env.attester(&op.address).exit_at, 0);
    env.send_operator(&op, &[request_exit_ix(&authority, &op.address)])
        .unwrap();
    let asked = env.now();
    env.warp(i64::from(asked + EXIT_DELAY));

    let lamports = env.lamports(&authority);
    withdraw(&mut env).unwrap();
    assert_eq!(env.balance(&destination), STAKE);
    assert!(env.svm.get_account(&op.escrow()).is_none());
    assert!(env.svm.get_account(&op.ledger()).is_none());
    assert_eq!(
        env.lamports(&authority) - lamports,
        env.rent(165) + env.rent(8 + Ledger::INIT_SPACE)
    );
    assert_eq!(env.attester(&op.address).status, attester_status::RETIRED);
    assert_eq!(
        env.send_operator(&op, &[request_exit_ix(&authority, &op.address)]),
        Err(code(0, E::AttesterStatus))
    );
}

// Reporting a false ticket

#[test]
fn a_ticket_for_a_lock_that_never_existed_burns_the_whole_stake_and_pays_nobody() {
    let mut env = env();
    let op = env.registered(1, 11, STAKE);
    env.send_operator(&op, &[top_up_ix(&env, &op, 5)]).unwrap();
    let phantom = env.unregistered_user(0);
    let ticket = op.ticket(TicketFields::phantom(&env, phantom.key.sec1()));
    let (supply, paid, held) = (env.total_supply(), env.paid_out(), env.balance(&op.token));
    let reporter = env.funded_keypair();
    let landed = env
        .send(
            &reporter,
            &report_ixs(&env, &reporter.pubkey(), &ticket, &op.public()),
        )
        .unwrap();
    eprintln!(
        "report_false_ticket: {} CU, {} bytes",
        landed.units, landed.size
    );

    let a = env.attester(&op.address);
    assert_eq!((a.status, a.exit_at), (attester_status::SLASHED, env.now()));
    let ledger = env.ledger(&op.address);
    assert_eq!((ledger.bond_free, ledger.bond_slashed), (0, 0));
    assert_eq!(env.total_supply(), supply - (STAKE + 5));
    assert_eq!(env.balance(&op.escrow()), 0);
    assert_eq!((env.paid_out(), env.balance(&op.token)), (paid, held));
    assert_eq!(
        report(&mut env, &op, &ticket),
        Err(code(1, E::AlreadySlashed))
    );
}

#[test]
fn a_device_counter_below_the_sequence_number_makes_it_never_existed_too() {
    let (mut env, op, user, _) = scene();
    let mut fields = TicketFields::phantom(&env, user.key.sec1());
    fields.lock_seq = 1;
    report(&mut env, &op, &op.ticket(fields)).unwrap();
    assert_eq!(env.attester(&op.address).status, attester_status::SLASHED);
}

#[test]
fn a_ticket_that_differs_from_its_lock_in_any_field_burns_the_stake() {
    type Change = fn(&mut TicketFields);
    let changes: [Change; 4] = [
        |f| f.mint = [9; 32],
        |f| f.bond += 1,
        |f| f.backing -= 1,
        |f| f.lock_until += 1,
    ];
    for change in changes {
        let (mut env, op, user, lock) = scene();
        let mut fields = TicketFields::of(&env, &user, &lock);
        change(&mut fields);
        let supply = env.total_supply();
        report(&mut env, &op, &op.ticket(fields)).unwrap();
        assert_eq!(env.total_supply(), supply - STAKE);
        assert_eq!(env.attester(&op.address).status, attester_status::SLASHED);
    }
}

#[test]
fn a_true_ticket_is_never_reportable_while_its_lock_exists_or_after_it_closed() {
    let (mut env, op, user, lock) = scene();
    let ticket = op.ticket(TicketFields::of(&env, &user, &lock));
    assert_eq!(
        report(&mut env, &op, &ticket),
        Err(code(1, E::TicketNotProvablyFalse))
    );

    env.warp(i64::from(lock.until) + i64::from(CLAIM_WINDOW));
    env.try_withdraw(&user, &user, &lock).unwrap();
    let closes_at = i64::from(lock.until) + i64::from(RECORD_TTL);
    env.warp(closes_at);
    env.try_close(&user, &lock).unwrap();
    for later in [0, 1, 1_000_000] {
        env.warp(closes_at + later);
        assert_eq!(
            report(&mut env, &op, &ticket),
            Err(code(1, E::TicketNotProvablyFalse)),
            "+{later}"
        );
    }
    assert_eq!(env.attester(&op.address).status, attester_status::ACTIVE);
}

#[test]
fn a_false_ticket_over_a_closed_lock_is_burned_while_its_claim_is_current() {
    let (mut env, op, user, lock) = scene();
    env.warp(i64::from(lock.until) + i64::from(CLAIM_WINDOW));
    env.try_withdraw(&user, &user, &lock).unwrap();
    env.warp(i64::from(lock.until) + i64::from(RECORD_TTL));
    env.try_close(&user, &lock).unwrap();
    let now = env.now();
    let mut fields = TicketFields::of(&env, &user, &lock);
    fields.lock_until = now - RECORD_TTL;
    assert_eq!(
        report(&mut env, &op, &op.ticket(fields)),
        Err(code(1, E::TicketNotProvablyFalse))
    );
    fields.lock_until = now - RECORD_TTL + 1;
    report(&mut env, &op, &op.ticket(fields)).unwrap();
    assert_eq!(env.attester(&op.address).status, attester_status::SLASHED);
}

#[test]
fn the_report_needs_the_exact_verification_of_the_ticket_by_the_attester() {
    let phantom = |env: &mut Env| env.unregistered_user(0).key.sec1();
    let mut env = env();
    let op = env.registered(1, 11, STAKE);
    let reporter = env.funded_keypair();
    let r = reporter.pubkey();
    let device = phantom(&mut env);
    let ticket = op.ticket(TicketFields::phantom(&env, device));
    let message = ticket.signed_message(&buckspay::ticket_domain());
    let good = ed25519_ix(&op.public(), &ticket.signature, &message);
    let report = report_ix(&env, &r, &ticket);
    let active = |env: &Env| env.attester(&op.address).status == attester_status::ACTIVE;

    // No verification, or one that is not right before the report.
    assert_eq!(
        env.send(&reporter, std::slice::from_ref(&report)),
        Err(code(0, E::TicketBinding))
    );
    let filler = system_instruction::transfer(&r, &r, 1);
    assert_eq!(
        env.send(&reporter, &[good.clone(), filler, report.clone()]),
        Err(code(2, E::TicketBinding))
    );
    // Another message that the attester did sign.
    let other = signing(11).sign(b"another message").to_bytes();
    let other_ix = ed25519_ix(&op.public(), &other, b"another message");
    assert_eq!(
        env.send(&reporter, &[other_ix, report.clone()]),
        Err(code(1, E::TicketBinding))
    );
    // Offsets into another instruction instead of inline data: the precompile accepts them, the
    // program does not.
    let mut offsets = good.clone();
    for field in [4usize, 8, 14] {
        offsets.data[field..field + 2].copy_from_slice(&0u16.to_le_bytes());
    }
    assert_eq!(
        env.send(&reporter, &[offsets, report.clone()]),
        Err(code(1, E::TicketBinding))
    );
    // Trailing bytes, a second signature slot and a key that did not sign it.
    let mut trailing = good.clone();
    trailing.data.push(0);
    assert_eq!(
        env.send(&reporter, &[trailing, report.clone()]),
        Err(code(1, E::TicketBinding))
    );
    let mut two = good.clone();
    two.data[0] = 2;
    assert!(env.send(&reporter, &[two, report.clone()]).is_err());
    let theirs = ed25519_ix(&public(&signing(12)), &ticket.signature, &message);
    assert!(env.send(&reporter, &[theirs, report.clone()]).is_err());
    assert!(active(&env));

    // A ticket by attester B that names attester A answers to nobody.
    let b = env.registered(2, 12, STAKE);
    let device = phantom(&mut env);
    let forged = op.sign_with(&b.key, TicketFields::phantom(&env, device));
    let message = forged.signed_message(&buckspay::ticket_domain());
    let verify_by_b = ed25519_ix(&b.public(), &forged.signature, &message);
    assert_eq!(
        env.send(&reporter, &[verify_by_b, report_ix(&env, &r, &forged)]),
        Err(code(1, E::UnknownSigner))
    );
    assert!(active(&env));

    env.send(&reporter, &[good, report]).unwrap();
    assert!(!active(&env));
}

#[test]
fn a_ticket_signed_under_another_domain_does_not_burn_anything() {
    let mut env = env();
    let op = env.registered(1, 11, STAKE);
    let device = env.unregistered_user(0).key.sec1();
    let mut ticket = op.ticket(TicketFields::phantom(&env, device));
    let mut message = ticket.signed_message(&buckspay::ticket_domain());
    message[..32].copy_from_slice(&[9; 32]);
    ticket.signature = op.key.sign(&message).to_bytes();
    let reporter = env.funded_keypair();
    let ixs = [
        ed25519_ix(&op.public(), &ticket.signature, &message),
        report_ix(&env, &reporter.pubkey(), &ticket),
    ];
    assert_eq!(env.send(&reporter, &ixs), Err(code(1, E::TicketBinding)));
    assert_eq!(env.attester(&op.address).status, attester_status::ACTIVE);
}

#[test]
fn a_key_rotated_out_stays_reportable_for_the_tail_and_not_after() {
    for (offset, expected) in [
        (EXIT_DELAY - 1, Ok(())),
        (EXIT_DELAY, Err(code(1, E::UnknownSigner))),
    ] {
        let mut env = env();
        let op = env.registered(1, 11, STAKE);
        let device = env.unregistered_user(0).key.sec1();
        let old_ticket = op.ticket(TicketFields::phantom(&env, device));
        let start = env.now();
        env.send_operator(&op, &[rotate_ix(&op, &public(&signing(12)), false)])
            .unwrap();
        env.warp(i64::from(start + offset));
        assert_eq!(report(&mut env, &op, &old_ticket), expected, "+{offset}");
    }
}

#[test]
fn an_attester_that_asked_to_leave_is_reportable_until_it_has_left() {
    let mut env = env();
    let op = env.registered(1, 11, STAKE);
    let destination = env.token_account_of(&Keypair::new().pubkey(), 0);
    let authority = op.authority.pubkey();
    env.send_operator(&op, &[request_exit_ix(&authority, &op.address)])
        .unwrap();
    let asked = env.now();
    env.warp(i64::from(asked + EXIT_DELAY - 1));
    let device = env.unregistered_user(0).key.sec1();
    let supply = env.total_supply();
    let ticket = op.ticket(TicketFields::phantom(&env, device));
    report(&mut env, &op, &ticket).unwrap();
    let a = env.attester(&op.address);
    assert_eq!((a.status, a.exit_at), (attester_status::SLASHED, asked));
    assert_eq!(env.total_supply(), supply - STAKE);

    let ix = withdraw_stake_ix(&env, &op, &destination, &authority);
    assert_eq!(
        env.send_operator(&op, std::slice::from_ref(&ix)),
        Err(code(0, E::ExitNotReady))
    );
    env.warp(i64::from(asked + EXIT_DELAY));
    env.send_operator(&op, &[ix]).unwrap();
    assert_eq!(env.balance(&destination), 0);
    assert_eq!(env.attester(&op.address).status, attester_status::RETIRED);
    assert!(env.svm.get_account(&op.escrow()).is_none());
}

#[test]
fn a_report_with_substituted_accounts_is_refused_and_burns_nothing() {
    let mut env = env();
    let a = env.registered(1, 11, STAKE);
    let b = env.registered(2, 12, STAKE);
    let user = env.user(2_000_000_000);
    let lock = lock_for(&mut env, &user, 400_000_000, 1_000_000_000, MIN_LOCK + DAY);
    let device = env.unregistered_user(0).key.sec1();
    let ticket = a.ticket(TicketFields::phantom(&env, device));
    let reporter = env.funded_keypair();
    let r = reporter.pubkey();
    let good = report_ix(&env, &r, &ticket);
    let ed = report_ixs(&env, &r, &ticket, &a.public())[0].clone();
    let meta = |ix: &Instruction, index: usize, address: Pubkey| {
        let mut ix = ix.clone();
        ix.accounts[index].pubkey = address;
        ix
    };
    // Account order: reporter, attester, ledger, escrow, mint, device, lock, instructions, token program.
    let cases = [
        (1, b.address, 2006),
        (2, b.ledger(), 2006),
        (3, b.escrow(), 2006),
        (5, device_address(&user.key.sec1()), 2006),
        (6, lock.address, 2006),
        (4, env.add_mint(6), 2012),
    ];
    for (index, address, expected) in cases {
        let ix = meta(&good, index, address);
        assert_eq!(
            env.send(&reporter, &[ed.clone(), ix]),
            Err(constraint(1, expected)),
            "account {index}"
        );
    }
    for op in [&a, &b] {
        assert_eq!(env.attester(&op.address).status, attester_status::ACTIVE);
        assert_eq!(env.ledger(&op.address).bond_free, STAKE);
    }
}

// Layouts

#[test]
fn an_attester_is_156_bytes_at_its_seeds_with_a_canonical_stored_bump() {
    assert_eq!(8 + Attester::INIT_SPACE, 156);
    let mut env = env();
    let op = env.registered(300, 11, STAKE);
    assert_eq!(op.address, attester_address(300));
    assert_eq!(
        env.attester(&op.address).bump,
        bump(&[ATTESTER_SEED, &300u16.to_le_bytes()])
    );
    assert_eq!(
        env.ledger(&op.address).bump,
        bump(&[buckspay::LEDGER_SEED, op.address.as_ref()])
    );
}
