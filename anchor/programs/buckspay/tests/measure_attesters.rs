//! Compute units and transaction bytes of every attester instruction on the built binary, held to
//! a budget.
mod common;
use common::attesters::*;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

fn within(name: &str, landed: &Landed, units: u64, bytes: usize) {
    eprintln!("{name}: {} CU, {} bytes", landed.units, landed.size);
    assert!(
        landed.units <= units,
        "{name}: {} CU over {units}",
        landed.units
    );
    assert!(
        landed.size <= bytes,
        "{name}: {} bytes over {bytes}",
        landed.size
    );
}

#[test]
fn every_attester_instruction_stays_inside_its_budget() {
    let mut env = Env::new(TokenKind::Classic);
    let op = env.operator(1, 11);
    let landed = env.register_attester(&op, &op.public(), STAKE).unwrap();
    within("register_attester", &landed, 60_000, 700);

    let authority = op.authority.pubkey();
    let landed = env
        .send_operator(&op, &[top_up_ix(&env, &op, 1_000)])
        .unwrap();
    within("top_up_attester", &landed, 30_000, 500);
    let landed = env
        .send_operator(&op, &[rotate_ix(&op, &public(&signing(12)), true)])
        .unwrap();
    within("rotate_attester_key", &landed, 15_000, 400);
    let landed = env
        .send_operator(&op, &[request_exit_ix(&authority, &op.address)])
        .unwrap();
    within("request_attester_exit", &landed, 10_000, 300);
    let landed = env
        .send_operator(&op, &[cancel_exit_ix(&authority, &op.address)])
        .unwrap();
    within("cancel_attester_exit", &landed, 10_000, 300);

    let device = env.unregistered_user(0).key.sec1();
    // The key rotated in signs the ticket the report names.
    let current = Operator {
        key: signing(12),
        ..env_clone(&op)
    };
    let ticket = current.ticket(TicketFields::phantom(&env, device));
    let reporter = env.funded_keypair();
    let landed = env
        .send(
            &reporter,
            &report_ixs(&env, &reporter.pubkey(), &ticket, &current.public()),
        )
        .unwrap();
    within("report_false_ticket", &landed, 50_000, 900);

    env.send_operator(&op, &[request_exit_ix(&authority, &op.address)])
        .ok();
    let destination = env.token_account_of(&Keypair::new().pubkey(), 0);
    env.warp(i64::from(env.now() + buckspay_protocol::attest::EXIT_DELAY));
    let landed = env
        .send_operator(
            &op,
            &[withdraw_stake_ix(&env, &op, &destination, &authority)],
        )
        .unwrap();
    within("withdraw_attester_stake", &landed, 40_000, 600);
}

fn env_clone(op: &Operator) -> Operator {
    Operator {
        id: op.id,
        authority: op.authority.insecure_clone(),
        key: signing(11),
        token: op.token,
        address: op.address,
    }
}
