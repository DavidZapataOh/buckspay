//! Compute units and transaction sizes of the claim instructions on the built binary, with the cluster's token program, and the limits of the chains they carry.
mod common;
use buckspay_protocol::{Caveats, Outputs, Owner, Spend, NO_LOCK};
use common::claims::*;
use common::*;

/// A chain from the issuer's lock through `holders` ending at the victim's device key.
fn long_chain(w: &World, start: u64, holders: &[Key], last_owner: Owner) -> Chain {
    let first = holders.first().map_or(last_owner, |holder| holder.owner());
    let mut chain = Chain::issue(
        &w.issuer.key,
        &w.env.mint,
        0,
        start,
        AMOUNT,
        first,
        caveats(w.expiry, 12),
    );
    for (i, holder) in holders.iter().enumerate() {
        let next = holders.get(i + 1).map_or(last_owner, |next| next.owner());
        chain = chain.spend(holder, 0, |c| Spend {
            input: c.id,
            lock_seq: 0,
            salt: [i as u8 + 1; 16],
            outputs: Outputs::One {
                owner: next,
                caveats: Caveats {
                    hops_left: c.caveats.hops_left - 1,
                    ..c.caveats
                },
            },
        });
    }
    chain
}

#[test]
fn the_instructions_fit_their_budgets() {
    let mut w = world();
    let (winning, losing) = (w.winning(0), w.losing(0, 2));
    w.settle(&winning).unwrap();
    let first = w.claim(&losing).unwrap();
    let second = w.losing(0, 3);
    let next = w.claim(&second).unwrap();
    let claim = claim_address(&losing.last.first.id);
    let closable = w.env.claim(&losing.last.first.id).unwrap().closable_at;
    w.env.warp(i64::from(closable));
    let payer = w.payer();
    let close = w
        .env
        .submit(&[close_records_ix(&[(claim, payer)])])
        .unwrap();
    eprintln!("claim_lost_spend, the first {first:?}");
    eprintln!("claim_lost_spend, the second {next:?}");
    eprintln!("close_records {close:?}");
    assert!(first.units <= 60_000 && first.size <= 1_232);
    assert!(next.units <= 60_000 && next.size <= 1_232);
    assert!(close.units <= 20_000 && close.size <= 1_232);
}

#[test]
fn a_claim_verifies_one_signature_however_long_the_chain_is() {
    for n in [1usize, 3, 6] {
        let mut w = world();
        let mut holders: Vec<Key> = (0..n - 1).map(|i| Key::new(100 + i as u8)).collect();
        let winning = long_chain(&w, 0, &holders, w.culprit.key.owner()).spend1_to_account(
            &w.culprit.key,
            0,
            &w.winner,
            0,
            9,
        );
        holders.push(Key::new(2));
        let losing = long_chain(&w, 0, &holders, w.victim.key.owner());
        let payer = w.payer();
        let ixs = settle_ixs(&w.env, &payer, &w.issuer, &winning, &w.winner_token);
        w.env.send_v1(&ixs).unwrap();
        let ixs = claim_lost_ixs(
            &payer,
            &w.culprit.lock,
            w.culprit.key.sec1(),
            0,
            &w.env.mint,
            &losing,
        );
        let landed = w.env.send_v1(&ixs).unwrap();
        eprintln!("claim_lost_spend, {n} spends: {landed:?} (v1)");
        assert!(landed.size <= 4_096 && landed.units <= 100_000);
    }
}

#[test]
fn an_unbacked_claim_verifies_the_whole_chain_up_to_eight_signatures() {
    for m in [0usize, 3, 7] {
        let mut w = world();
        w.issuer = w.env.issuer(11, BOND, 30_000_000, 60);
        let holder = Key::new(60);
        let x = long_chain(&w, 0, &[], holder.owner())
            .spend1_to_account(&holder, 0, &w.winner, NO_LOCK, 1);
        w.settle(&x).unwrap();
        let holders: Vec<Key> = (0..m).map(|i| Key::new(120 + i as u8)).collect();
        let y = long_chain(&w, 10_000_000, &holders, w.victim.key.owner());
        let ixs = claim_unbacked_ixs(&w.payer(), &w.issuer.lock, &w.env.mint, &y);
        let landed = w.env.send_v1(&ixs).unwrap();
        eprintln!(
            "claim_unbacked, {m} spends, {} signatures: {landed:?} (v1)",
            m + 1
        );
        assert!(landed.size <= 4_096 && landed.units <= 100_000);
    }
}

#[test]
fn the_account_size_is_the_one_the_rent_table_uses() {
    let mut w = world();
    let (winning, losing) = (w.winning(0), w.losing(0, 2));
    w.settle(&winning).unwrap();
    w.claim(&losing).unwrap();
    let account = w
        .env
        .svm
        .get_account(&claim_address(&losing.last.first.id))
        .unwrap();
    assert_eq!(account.data.len(), 92);
    assert_eq!(account.lamports, w.env.rent(92));
    eprintln!("Claim: 92 bytes, {} lamports", account.lamports);
}

#[test]
fn the_refusal_of_an_output_that_cannot_be_claimed_is_as_cheap_as_a_claim() {
    // The worst case of a ground output is a refusal after the signature check, not a search.
    let mut w = world();
    let winning = w.winning(0);
    w.settle(&winning).unwrap();
    let ground = (0u16..)
        .map(|n| {
            w.base(0).spend_raw(&w.culprit.key, 0, |c| Spend {
                input: c.id,
                lock_seq: 0,
                salt: salted([9; 16], n),
                outputs: Outputs::One {
                    owner: w.victim.key.owner(),
                    caveats: Caveats {
                        hops_left: c.caveats.hops_left - 1,
                        expiry: c.caveats.expiry - buckspay_protocol::lock::EXPIRY_STEP,
                        ..c.caveats
                    },
                },
            })
        })
        .find(|chain| {
            spent_address_of(&chain.last.first.id).is_some()
                && claim_address_of(&chain.last.first.id).is_none()
        })
        .unwrap();
    let ixs = claim_lost_ixs(
        &w.payer(),
        &w.culprit.lock,
        w.culprit.key.sec1(),
        0,
        &w.env.mint,
        &ground,
    );
    let refused = w.env.failed_units(&ixs);
    eprintln!("refused claim: {refused} CU");
    assert!(refused <= 60_000);
}
