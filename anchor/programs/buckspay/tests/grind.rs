//! The compute units of a settlement are fixed by the shape of its chain, not by the salts its
//! signers choose. Searching for the canonical bump of every record address (1,500 CU per failed
//! bump) over output ids that hash a signer-chosen salt would let a signer who tried about 2^13
//! salts take a single hop from 23,763 CU to 44,763 and seven spends from 69,384 to 195,384. Every
//! record address is derived with one fixed bump instead, and an output whose address is on the
//! curve is refused.
mod common;
use anchor_lang::prelude::Pubkey;
use buckspay::{BuckspayError as E, ESCROW_SEED};
use buckspay_protocol::{chain, lock::EXPIRY_STEP, Caveats, Issue, Outputs, Spend, NO_LOCK};
use common::claims::claim_address_of;
use common::*;
use proptest::prelude::*;
use solana_signer::Signer;

const AMOUNT: u64 = 50_000_000;

/// A chain of `hops` spends (the last to `payee`) whose consumed outputs all satisfy `wanted`,
/// found by trying salts: the way an honest signer finds recordable ones (`wanted` = no failed
/// bump at all) and a hostile one finds expensive ones (`wanted` = many failed bumps).
fn chain_of(
    env: &Env,
    issuer: &Issuer,
    hops: usize,
    offset: u16,
    payee: &Pubkey,
    wanted: &dyn Fn(u32) -> bool,
) -> Chain {
    let keys: Vec<Key> = (0..hops as u32)
        .map(|i| Key::from_index(1_000 + i))
        .collect();
    let expiry = expiry_of(env, 10);
    let (issue, envelope, output) = (offset..)
        .map(|n| {
            let issue = Issue {
                issuer: issuer.key.sec1(),
                mint: env.mint.to_bytes(),
                lock_seq: 0,
                cum_end: AMOUNT,
                salt: salted([0x11; 16], n),
                owner: keys[0].owner(),
                amount: AMOUNT,
                caveats: caveats(expiry, 12),
            };
            let (envelope, output) =
                chain::issue_signing(&buckspay::note_domain(), &issue).unwrap();
            (issue, envelope, output)
        })
        .find(|(_, _, output)| wanted(failed_bumps(&output.id)))
        .unwrap();
    let mut chain = Chain {
        issue_body: issue.body(),
        links: vec![],
        signed: vec![Signed {
            key: issuer.key.sec1(),
            envelope,
            signature: issuer.key.sign(&envelope),
        }],
        last: chain::Holding {
            first: output,
            second: None,
        },
        issue,
    };
    for i in 0..hops - 1 {
        let consumed = chain.last.first;
        let next = keys[i + 1].owner();
        let spend = (offset..)
            .map(|n| Spend {
                input: consumed.id,
                lock_seq: 0,
                salt: salted([0x22; 16], n),
                outputs: Outputs::One {
                    owner: next,
                    caveats: Caveats {
                        hops_left: consumed.caveats.hops_left - 1,
                        expiry: consumed.caveats.expiry - EXPIRY_STEP,
                        ..consumed.caveats
                    },
                },
            })
            .find(|candidate| {
                let (_, env) =
                    chain::spend_signing(&buckspay::note_domain(), &consumed, candidate).unwrap();
                let (holding, _) = chain::spend_outputs(&env, &consumed, candidate).unwrap();
                wanted(failed_bumps(&holding.first.id))
            })
            .unwrap();
        chain = chain.spend_raw(&keys[i], 0, |_| spend);
    }
    chain.spend1_to_account(&keys[hops - 1], 0, payee, NO_LOCK, 9)
}

struct Setup {
    env: Env,
    issuer: Issuer,
    payee: Pubkey,
    destination: Pubkey,
}

fn setup() -> Setup {
    let mut env = Env::new(TokenKind::Classic);
    let issuer = env.issuer(1, 100_000_000, 1_000_000_000, 60);
    let payee = Pubkey::new_unique();
    let destination = env.token_account_of(&payee, 0);
    Setup {
        env,
        issuer,
        payee,
        destination,
    }
}

fn send(s: &mut Setup, chain: &Chain) -> Result<Landed, solana_transaction::TransactionError> {
    let payer = s.env.payer.pubkey();
    let ixs = settle_ixs(&s.env, &payer, &s.issuer, chain, &s.destination);
    s.env.send_v1(&ixs)
}

/// An output whose record address needs a search is not a more expensive output, it is refused
/// (with a search for the bump the same chains cost 44,763 CU and 195,384 CU).
#[test]
fn grinding_the_salt_cannot_make_a_settlement_cost_more() {
    for (hops, failed) in [(1usize, 14u32), (7, 12)] {
        let mut s = setup();
        let hostile = chain_of(&s.env, &s.issuer, hops, 0, &s.payee, &|n| n >= failed);
        let spent = consumed_outputs(&hostile);
        assert!(
            spent.iter().all(|o| failed_bumps(o) >= failed),
            "{hops}: every record is ground"
        );
        assert_eq!(
            send(&mut s, &hostile).unwrap_err(),
            code(1, E::UnrecordableOutput),
            "{hops} hops, {failed} failed bumps per record"
        );
        assert_eq!(s.env.balance(&s.destination), 0);
        assert!(
            spent.iter().all(|o| s.env.spent(o).is_none()),
            "nothing was written"
        );
    }
}

#[test]
fn the_compute_units_depend_on_the_shape_of_the_chain_only() {
    for hops in [1usize, 2, 4, 7] {
        let mut s = setup();
        let mut units = std::collections::BTreeSet::new();
        for offset in 0..12u16 {
            let chain = chain_of(&s.env, &s.issuer, hops, offset * 97, &s.payee, &|n| n == 0);
            units.insert(send(&mut s, &chain).unwrap().units);
        }
        assert_eq!(
            units.len(),
            1,
            "{hops} hops over 12 different salts: {units:?}"
        );
        let units = *units.first().unwrap();
        eprintln!("{hops} spends: {units} CU whatever the salts");
        assert!(units <= 100_000, "{hops} spends cost {units} CU");
    }
}

fn unrecordable(wanted_hop: bool, s: &Setup, second: &Issuer) -> Chain {
    // The issue's output is recordable; the output the first spend gives to `second` is not.
    let issue = Chain::issue(
        &s.issuer.key,
        &s.env.mint,
        0,
        0,
        AMOUNT,
        s.issuer.key.owner(),
        caveats(expiry_of(&s.env, 10), 6),
    );
    let chain = issue.spend_raw(&s.issuer.key, 0, |c| {
        (0u16..)
            .map(|n| Spend {
                input: c.id,
                lock_seq: 0,
                salt: salted([0x33; 16], n),
                outputs: Outputs::One {
                    owner: second.key.owner(),
                    caveats: Caveats {
                        hops_left: c.caveats.hops_left - 1,
                        expiry: c.caveats.expiry - EXPIRY_STEP,
                        ..c.caveats
                    },
                },
            })
            .find(|candidate| {
                let (_, env) =
                    chain::spend_signing(&buckspay::note_domain(), c, candidate).unwrap();
                let (holding, _) = chain::spend_outputs(&env, c, candidate).unwrap();
                spent_address_of(&holding.first.id).is_none()
            })
            .unwrap()
    });
    if wanted_hop {
        chain.spend1_to_account(&second.key, 0, &s.payee, NO_LOCK, 9)
    } else {
        chain
    }
}

#[test]
fn an_output_without_a_record_address_is_refused_by_every_instruction_and_writes_nothing() {
    let mut s = setup();
    let second = s.env.issuer(3, 1_000_000, 10_000_000, 60);
    let payer = s.env.payer.pubkey();
    let settle = unrecordable(true, &s, &second);
    assert_eq!(
        send(&mut s, &settle).unwrap_err(),
        code(1, E::UnrecordableOutput)
    );

    let prefix = record_prefix_ixs(&payer, &s.issuer, &settle, 0);
    assert_eq!(
        s.env.submit(&prefix).unwrap_err(),
        code(1, E::UnrecordableOutput)
    );
    assert!(consumed_outputs(&settle)
        .iter()
        .all(|o| s.env.spent(o).is_none() || recordable(o)));

    // The reclaim of the unrecordable output itself, inside its window.
    let held = unrecordable(false, &s, &second);
    let expiry = held.last.first.caveats.expiry;
    s.env
        .warp(i64::from(expiry) + i64::from(buckspay_protocol::GRACE) + 1);
    let reclaim = reclaim_ixs(
        &s.env,
        &payer,
        &s.issuer,
        &held,
        0,
        &second.key,
        &second.wallet_token,
    );
    assert_eq!(
        s.env.submit(&reclaim).unwrap_err(),
        code(1, E::UnrecordableOutput)
    );
    assert_eq!(s.env.balance(&second.wallet_token), 0);
    assert_eq!(s.env.ledger(&s.issuer.lock).backing_left, 1_000_000_000);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(4_096))]

    /// The protocol crate's `record::address` (what receivers, the gateway and the signer use)
    /// and the program's `create_program_address` agree on every output id.
    #[test]
    fn the_program_and_the_protocol_crate_agree_on_every_record_address(id in any::<[u8; 32]>()) {
        prop_assert_eq!(
            buckspay_protocol::record::address(&buckspay::ID.to_bytes(), &id),
            spent_address_of(&id).map(|a| a.to_bytes())
        );
    }

    /// The same for the address of the claim of an output.
    #[test]
    fn the_program_and_the_protocol_crate_agree_on_every_claim_address(id in any::<[u8; 32]>()) {
        prop_assert_eq!(
            buckspay_protocol::record::claim_address(&buckspay::ID.to_bytes(), &id),
            claim_address_of(&id).map(|a| a.to_bytes())
        );
    }
}

fn escrow_failures(lock: &Pubkey) -> u32 {
    (0..=255u8)
        .rev()
        .take_while(|bump| {
            Pubkey::create_program_address(&[ESCROW_SEED, lock.as_ref(), &[*bump]], &buckspay::ID)
                .is_err()
        })
        .count() as u32
}

/// An issuer picks its key, so it can pick a lock whose escrow needs many bumps. The escrow's
/// bump is stored in the lock, so that costs every settlement on it nothing.
#[test]
fn a_lock_ground_to_a_high_escrow_bump_costs_the_same_to_settle() {
    let (cheap, dear) = {
        let mut cheap = None;
        let mut dear = None;
        for i in 0u32.. {
            let failures = escrow_failures(&lock_address(&Key::from_index(i).sec1(), 0));
            if failures == 0 && cheap.is_none() {
                cheap = Some(i);
            }
            if failures >= 6 && dear.is_none() {
                dear = Some((i, failures));
            }
            if cheap.is_some() && dear.is_some() {
                break;
            }
        }
        (cheap.unwrap(), dear.unwrap())
    };
    eprintln!("lock with {} failed escrow bumps (key {})", dear.1, dear.0);
    let units = |index: u32| {
        let mut env = Env::new(TokenKind::Classic);
        let issuer = env.issuer_with_key(Key::from_index(index), 100_000_000, 1_000_000_000, 60);
        let payee = Pubkey::new_unique();
        let destination = env.token_account_of(&payee, 0);
        let mut s = Setup {
            env,
            issuer,
            payee,
            destination,
        };
        let chain = chain_of(&s.env, &s.issuer, 1, 0, &s.payee, &|n| n == 0);
        let settled = send(&mut s, &chain).unwrap().units;
        // And the issuer takes back an output nobody settled: the reclaim derives the escrow too.
        let held = Chain::issue(
            &s.issuer.key,
            &s.env.mint,
            0,
            AMOUNT,
            AMOUNT,
            s.issuer.key.owner(),
            caveats(expiry_of(&s.env, 10), 6),
        );
        s.env.warp(
            i64::from(held.last.first.caveats.expiry) + i64::from(buckspay_protocol::GRACE) + 1,
        );
        let payer = s.env.payer.pubkey();
        let wallet = s.issuer.wallet_token;
        let ixs = reclaim_ixs(&s.env, &payer, &s.issuer, &held, 0, &s.issuer.key, &wallet);
        let reclaimed = s.env.send_v1(&ixs).unwrap().units;
        (settled, reclaimed)
    };
    // Two different issuers differ by a few tens of CU (comparisons of unlike keys exit early),
    // never by the 1,500 CU of one bump that fails: 7 of them would be 10,500.
    let (cheap_units, dear_units) = (units(cheap), units(dear.0));
    eprintln!(
        "(settle, reclaim) {cheap_units:?} CU with a canonical escrow bump, {dear_units:?} CU with {} failed ones",
        dear.1
    );
    assert!(
        cheap_units.0.abs_diff(dear_units.0) <= 100,
        "settle: {cheap_units:?} against {dear_units:?}"
    );
    assert!(
        cheap_units.1.abs_diff(dear_units.1) <= 100,
        "reclaim: {cheap_units:?} against {dear_units:?}"
    );
}
