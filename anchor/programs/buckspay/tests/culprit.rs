//! The culprit at the exact hop. The honest chain has `n` spends: spend `j` (0-based) is signed by
//! holder `H(j + 1)` and pays `H(j + 2)`, the last one the victim's device. `fork_at(k)` replaces
//! the spend signed by `Hk` with a payment of the same output to the winner's account, so the
//! finder names hop `k - 1`.
mod common;
use anchor_lang::{prelude::Pubkey, solana_program::instruction::Instruction, InstructionData};
use buckspay::{records::RECLAIMED, BuckspayError as E};
use buckspay_protocol::{
    hash::content,
    record::{first_conflict, RecordRef},
    secp256r1::MAX_SIGNATURES,
    Caveats, Outputs, Owner, Spend,
};
use common::claims::*;
use common::*;
use proptest::prelude::*;
use solana_signer::Signer;
use solana_transaction::TransactionError;

const PAYMENT: u64 = 40_000_000;
const HOLDER_BOND: u64 = 400_000_000;

struct Cast {
    env: Env,
    issuer: Issuer,
    holders: Vec<Issuer>,
    victim: Key,
    winner: Pubkey,
    winner_token: Pubkey,
    expiry: u32,
}

impl Cast {
    fn new(holders: usize) -> Self {
        let mut env = Env::new(TokenKind::Classic);
        let issuer = env.issuer(1, HOLDER_BOND, 1_000_000_000, 60);
        let holders = (0..holders)
            .map(|i| env.issuer(10 + i as u8, HOLDER_BOND, 10_000_000, 60))
            .collect();
        let winner = Pubkey::new_unique();
        let winner_token = env.token_account_of(&winner, 0);
        let expiry = expiry_of(&env, 10);
        Cast {
            env,
            issuer,
            holders,
            victim: Key::new(200),
            winner,
            winner_token,
            expiry,
        }
    }

    fn payer(&self) -> Pubkey {
        self.env.payer.pubkey()
    }

    fn pays(&self, chain: Chain, signer: &Key, input: u8, to: Owner, salt: u8) -> Chain {
        chain.spend(signer, input, |c| Spend {
            input: c.id,
            lock_seq: 0,
            salt: [salt; 16],
            outputs: Outputs::One {
                owner: to,
                caveats: Caveats {
                    hops_left: c.caveats.hops_left - 1,
                    ..c.caveats
                },
            },
        })
    }

    fn issue_to_first(&self) -> Chain {
        Chain::issue(
            &self.issuer.key,
            &self.env.mint,
            0,
            0,
            PAYMENT,
            self.holders[0].key.owner(),
            caveats(self.expiry, 16),
        )
    }

    /// The first `spends` spends of the honest chain, ending at the next holder's device key.
    fn honest_of(&self, spends: usize) -> Chain {
        let mut chain = self.issue_to_first();
        for j in 0..spends {
            let next = self
                .holders
                .get(j + 1)
                .map_or(self.victim.owner(), |h| h.key.owner());
            chain = self.pays(chain, &self.holders[j].key, 0, next, j as u8 + 1);
        }
        chain
    }

    fn honest(&self) -> Chain {
        self.honest_of(self.holders.len())
    }

    /// The chain whose spend signed by `Hk` pays the winner's account.
    fn fork_at(&self, k: usize) -> Chain {
        self.honest()
            .pay_account_at(&self.holders[k - 1].key, k - 1, &self.winner, 0xA0)
    }

    /// Records and settles a chain of any length in batches of at most eight signatures.
    fn settle_to_winner(&mut self, chain: &Chain) -> Result<Landed, TransactionError> {
        let spends = chain.links.len();
        let entries = spends + 1;
        let payer = self.payer();
        let mut covered = 0;
        while entries - covered > MAX_SIGNATURES {
            let n = (covered + MAX_SIGNATURES - 1).min(spends - 1);
            let ixs = record_prefix_ixs(&payer, &self.issuer, &chain.prefix(n), covered);
            self.env.send_v1(&ixs)?;
            covered = n + 1;
        }
        let ixs = settle_ixs_resumed(
            &self.env,
            &payer,
            &self.issuer,
            chain,
            &self.winner_token,
            covered,
        );
        self.env.send_v1(&ixs)
    }

    fn record(&mut self, chain: &Chain, covered: usize) -> Result<Landed, TransactionError> {
        let ixs = record_prefix_ixs(&self.payer(), &self.issuer, chain, covered);
        self.env.send_v1(&ixs)
    }

    /// The shared finder on the records the chain finds on chain.
    fn finder(&self, chain: &Chain) -> Option<usize> {
        let contents: Vec<[u8; 32]> = chain.links.iter().map(|l| content(&l.body)).collect();
        let records: Vec<Option<RecordRef>> = consumed_outputs(chain)
            .iter()
            .map(|o| {
                self.env.spent(o).map(|s| RecordRef {
                    content: s.content,
                    reclaimed: s.flags & RECLAIMED != 0,
                })
            })
            .collect();
        first_conflict(&contents, &records)
    }

    fn claim_ixs(&self, branch: &Chain, culprit: usize) -> Vec<Instruction> {
        let culprit = &self.holders[culprit];
        claim_lost_ixs(
            &self.payer(),
            &culprit.lock,
            culprit.key.sec1(),
            0,
            &self.env.mint,
            branch,
        )
    }

    /// Files the loss of `branch` against `H(culprit + 1)`.
    fn claim(&mut self, branch: &Chain, culprit: usize) -> Result<Landed, TransactionError> {
        let ixs = self.claim_ixs(branch, culprit);
        self.env.send_v1(&ixs)
    }

    fn free_bond(&self, holder: usize) -> u64 {
        self.env.ledger(&self.holders[holder].lock).bond_free
    }
}

fn payment_of(chain: &Chain, hop: usize) -> u64 {
    chain.prefix(hop + 1).last.first.amount
}

#[test]
fn a_double_spend_at_the_first_hop_burns_twice_the_culprits_payment() {
    let mut w = Cast::new(6);
    let honest = w.honest();
    let supply = w.env.supply();
    w.settle_to_winner(&w.fork_at(1)).unwrap();
    let hop = w.finder(&honest).unwrap();
    assert_eq!(hop, 0);
    w.claim(&honest.prefix(hop + 1), hop).unwrap();
    assert_eq!(supply - w.env.supply(), 2 * payment_of(&honest, hop));
    assert_eq!(w.free_bond(0), HOLDER_BOND - 2 * PAYMENT);
}

#[test]
fn a_double_spend_burns_twice_the_payment_not_the_amount_the_spend_consumed() {
    let mut w = Cast::new(2);
    let paid = PAYMENT / 4;
    let chain =
        w.issue_to_first()
            .spend2(&w.holders[0].key, 0, w.holders[1].key.owner(), paid, 0, 1);
    let supply = w.env.supply();
    w.settle_to_winner(&chain.pay_account_at(&w.holders[0].key, 0, &w.winner, 0xA0))
        .unwrap();
    assert_eq!(w.finder(&chain), Some(0));
    w.claim(&chain.prefix(1), 0).unwrap();
    assert_eq!(supply - w.env.supply(), 2 * paid);
    assert_eq!(w.free_bond(0), HOLDER_BOND - 2 * paid);
}

#[test]
fn a_double_spend_at_a_middle_hop_names_that_holder() {
    let mut w = Cast::new(6);
    let honest = w.honest();
    let supply = w.env.supply();
    w.settle_to_winner(&w.fork_at(3)).unwrap();
    let hop = w.finder(&honest).unwrap();
    assert_eq!(hop, 2);
    w.claim(&honest.prefix(hop + 1), hop).unwrap();
    assert_eq!(supply - w.env.supply(), 2 * payment_of(&honest, hop));
    assert_eq!(w.free_bond(2), HOLDER_BOND - 2 * PAYMENT);
    assert_eq!(w.free_bond(1), HOLDER_BOND);
}

/// The last holder pays two accounts with one output.
#[test]
fn a_double_spend_at_the_last_hop_names_the_last_holder() {
    let mut w = Cast::new(6);
    let honest = w.honest();
    w.settle_to_winner(&w.fork_at(6)).unwrap();
    assert_eq!(w.finder(&honest), Some(5));
    w.claim(&honest, 5).unwrap();
    assert_eq!(w.free_bond(5), HOLDER_BOND - 2 * PAYMENT);
}

/// `H2` pays `H3` half of its output with a `Spend2` and keeps the change, then spends the change
/// twice.
#[test]
fn a_double_spend_of_a_change_output_names_the_changes_owner() {
    let mut w = Cast::new(6);
    let split = {
        let c = w.pays(
            w.issue_to_first(),
            &w.holders[0].key,
            0,
            w.holders[1].key.owner(),
            1,
        );
        c.spend2(
            &w.holders[1].key,
            0,
            w.holders[2].key.owner(),
            PAYMENT / 2,
            0,
            2,
        )
    };
    let to_victim = w.pays(split.clone(), &w.holders[1].key, 1, w.victim.owner(), 3);
    let to_winner = split.spend1_to_account(&w.holders[1].key, 1, &w.winner, 0, 4);
    let supply = w.env.supply();
    w.settle_to_winner(&to_winner).unwrap();
    let hop = w.finder(&to_victim).unwrap();
    assert_eq!(hop, 2);
    w.claim(&to_victim.prefix(hop + 1), 1).unwrap();
    assert_eq!(supply - w.env.supply(), PAYMENT);
}

/// The loss is the part the culprit paid, not the whole output it consumed: `H1` pays half of its
/// output to `H2` with a `Spend2` and the whole of it to the winner.
#[test]
fn a_split_payment_burns_twice_the_part_paid_and_not_the_whole_output() {
    let mut w = Cast::new(2);
    let paid_half = w.issue_to_first().spend2(
        &w.holders[0].key,
        0,
        w.holders[1].key.owner(),
        PAYMENT / 2,
        0,
        1,
    );
    let to_winner =
        w.issue_to_first()
            .spend1_to_account(&w.holders[0].key, 0, &w.winner, NO_LOCK, 2);
    let supply = w.env.supply();
    w.settle_to_winner(&to_winner).unwrap();
    assert_eq!(w.finder(&paid_half), Some(0));
    w.claim(&paid_half, 0).unwrap();
    assert_eq!(supply - w.env.supply(), PAYMENT);
}

/// Two device branches after `H3`: the left one is recorded, the right one is claimed at hop 3.
#[test]
fn forked_device_branches_are_claimed_at_the_fork() {
    let mut w = Cast::new(6);
    let left = w.honest_of(4);
    let right = w.pays(
        left.prefix(2),
        &w.holders[2].key,
        0,
        w.holders[3].key.owner(),
        0xEE,
    );
    w.record(&left, 0).unwrap();
    assert_eq!(w.finder(&right), Some(2));
    w.claim(&right, 2).unwrap();
}

/// After the first conflict, a second double spend on the losing branch has no record.
#[test]
fn a_later_conflict_on_a_losing_branch_is_not_claimable() {
    let mut w = Cast::new(6);
    let honest = w.honest();
    w.settle_to_winner(&w.fork_at(2)).unwrap();
    assert_eq!(
        w.claim(&honest.prefix(5), 4).unwrap_err(),
        code(1, E::NoRecord)
    );
}

/// Truncating at an honest hop before the conflict proves nothing.
#[test]
fn an_honest_hop_cannot_be_named() {
    let mut w = Cast::new(6);
    let honest = w.honest();
    w.record(&honest.prefix(2), 0).unwrap();
    w.settle_to_winner(&w.fork_at(4)).unwrap();
    assert_eq!(
        w.claim(&honest.prefix(2), 1).unwrap_err(),
        code(1, E::NotConflicting)
    );
}

#[test]
fn two_downstream_holders_filing_the_same_loss_burn_once() {
    let mut w = Cast::new(6);
    let honest = w.honest();
    w.settle_to_winner(&w.fork_at(3)).unwrap();
    w.claim(&honest.prefix(3), 2).unwrap();
    let once = w.env.supply();
    assert_eq!(
        w.claim(&honest.prefix(3), 2).unwrap_err(),
        code(1, E::AlreadyClaimed)
    );
    assert_eq!(w.env.supply(), once);
}

/// A 16-spend branch is claimed at hop 14 with one signature, in one transaction.
#[test]
fn a_sixteen_spend_branch_is_claimed_at_hop_fourteen() {
    let mut w = Cast::new(16);
    let honest = w.honest();
    w.settle_to_winner(&w.fork_at(14)).unwrap();
    assert_eq!(w.finder(&honest), Some(13));
    let landed = w.claim(&honest.prefix(14), 13).unwrap();
    eprintln!("claim at hop 14: {} CU, {} B", landed.units, landed.size);
    assert!(landed.size <= 4_096 && landed.units <= 200_000);
}

/// An issuer backing 30 signs a chain of `spends` spends for [0, 20) and a note [10, 30) that is
/// paid for real: the backing left is 10, below the chain's 20.
fn over_issued(spends: usize) -> (Cast, Chain) {
    let mut w = Cast::new(spends);
    w.issuer = w.env.issuer(2, HOLDER_BOND, 30_000_000, 60);
    let chain = {
        let mut c = Chain::issue(
            &w.issuer.key,
            &w.env.mint,
            0,
            0,
            20_000_000,
            w.holders[0].key.owner(),
            caveats(w.expiry, 16),
        );
        for j in 0..spends {
            let next = w
                .holders
                .get(j + 1)
                .map_or(w.victim.owner(), |h| h.key.owner());
            c = w.pays(c, &w.holders[j].key, 0, next, j as u8 + 1);
        }
        c
    };
    let other = Key::new(61);
    let paid = Chain::issue(
        &w.issuer.key,
        &w.env.mint,
        0,
        10_000_000,
        20_000_000,
        other.owner(),
        caveats(w.expiry, 4),
    )
    .spend1_to_account(&other, 0, &w.winner, NO_LOCK, 1);
    let ixs = settle_ixs(&w.env, &w.payer(), &w.issuer, &paid, &w.winner_token);
    w.env.submit(&ixs).unwrap();
    (w, chain)
}

impl Cast {
    fn claim_unbacked(
        &mut self,
        chain: &Chain,
        covered: usize,
    ) -> Result<Landed, TransactionError> {
        let ixs = claim_unbacked_resumed_ixs(
            &self.payer(),
            &self.issuer.lock,
            &self.env.mint,
            chain,
            covered,
        );
        self.env.send_v1(&ixs)
    }
}

/// Fails before: `TooManySpends` (or the precompile's count) for 13 signatures.
#[test]
fn an_unbacked_claim_of_twelve_spends_verifies_only_the_unvouched_messages() {
    let (mut w, chain) = over_issued(12);
    w.record(&chain.prefix(7), 0).unwrap();
    let landed = w.claim_unbacked(&chain, 8).unwrap();
    eprintln!(
        "claim_unbacked of 12 spends: {} CU, {} B",
        landed.units, landed.size
    );
    assert!(landed.size <= 4_096 && landed.units <= 200_000);
}

/// Nine unvouched messages are refused by the program, before any signature is checked: the
/// instruction carries the last 8 entries while the records vouch for the first 4.
#[test]
fn an_unbacked_claim_with_nine_unvouched_messages_is_refused() {
    let (mut w, chain) = over_issued(12);
    w.record(&chain.prefix(3), 0).unwrap();
    assert_eq!(
        w.claim_unbacked(&chain, 5).unwrap_err(),
        code(1, E::TooManySpends)
    );
}

#[test]
fn a_differing_record_does_not_vouch_for_an_unbacked_claim() {
    let (mut w, chain) = over_issued(4);
    let mut other = chain.clone();
    other.resign_link(&w.holders[0].key.clone(), 0, 0xEE);
    w.record(&other, 0).unwrap();
    assert_eq!(
        w.claim_unbacked(&chain, 2).unwrap_err(),
        code(1, E::NotClaimable)
    );
}

/// Fails before: walks 17 bodies before failing.
#[test]
fn a_seventeen_link_claim_is_refused_before_the_walk() {
    let mut w = Cast::new(16);
    let honest = w.honest();
    w.settle_to_winner(&w.fork_at(1)).unwrap();
    let mut ixs = w.claim_ixs(&honest, 15);
    let mut links = honest.links.clone();
    links.push(links[15].clone());
    ixs[1].data = buckspay::instruction::ClaimLostSpend {
        lost: buckspay::LostSpend {
            issue: honest.issue_body,
            spends: links,
            lock_key: w.holders[15].key.sec1(),
            lock_seq: 0,
        },
    }
    .data();
    let (err, units) = w.env.failed_v1(&ixs);
    assert_eq!(err, code(1, E::TooManySpends));
    assert!(units < 30_000, "walked {units} CU before refusing");
}

/// The off-chain finder and the program agree at every hop of a 6-holder chain: the claim
/// truncated at the finder's hop lands, at any other hop it fails for the stated reason.
#[test]
fn the_finder_and_the_program_agree_on_every_hop() {
    for k in 1..=6 {
        let mut w = Cast::new(6);
        let honest = w.honest();
        w.settle_to_winner(&w.fork_at(k)).unwrap();
        let hop = w.finder(&honest).unwrap();
        assert_eq!(hop, k - 1);
        for other in (0..honest.links.len()).filter(|&j| j != hop) {
            let expected = if other < hop {
                E::NotConflicting
            } else {
                E::NoRecord
            };
            assert_eq!(
                w.claim(&honest.prefix(other + 1), other).unwrap_err(),
                code(1, expected),
                "hop {other} of a fork at {hop}"
            );
        }
        w.claim(&honest.prefix(hop + 1), hop).unwrap();
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(24))]
    /// At any depth, one claim at the finder's hop burns twice the culprit's payment, nobody is
    /// paid, and no other lock loses anything.
    #[test]
    fn one_burn_of_twice_the_payment_at_any_depth(n in 1usize..=16, pick in 0usize..16) {
        let k = 1 + pick % n;
        let mut w = Cast::new(n);
        let honest = w.honest();
        w.settle_to_winner(&w.fork_at(k)).unwrap();
        let hop = w.finder(&honest).unwrap();
        prop_assert_eq!(hop, k - 1);
        let (supply, winner) = (w.env.supply(), w.env.balance(&w.winner_token));
        let paid: Vec<u64> = w.holders.iter().map(|h| w.env.balance(&h.wallet_token)).collect();
        w.claim(&honest.prefix(hop + 1), hop).unwrap();
        prop_assert_eq!(supply - w.env.supply(), 2 * PAYMENT);
        prop_assert_eq!(w.env.balance(&w.winner_token), winner);
        for (i, holder) in w.holders.iter().enumerate() {
            prop_assert_eq!(w.env.balance(&holder.wallet_token), paid[i]);
            let free = if i == hop { HOLDER_BOND - 2 * PAYMENT } else { HOLDER_BOND };
            prop_assert_eq!(w.free_bond(i), free);
        }
    }
}

/// Prints the compute units and size of the claims at depth; every one stays within a transaction
/// v1 and the compute budget of the batches.
#[test]
fn claims_at_depth_fit_their_budgets() {
    for hop in [8, 12, 16] {
        let mut w = Cast::new(16);
        let honest = w.honest();
        w.settle_to_winner(&w.fork_at(hop)).unwrap();
        let landed = w.claim(&honest.prefix(hop), hop - 1).unwrap();
        eprintln!(
            "claim_lost_spend at hop {hop}: {} CU, {} B",
            landed.units, landed.size
        );
        assert!(landed.size <= 4_096 && landed.units <= 200_000);
    }
    for spends in [12, 16] {
        let (mut w, chain) = over_issued(spends);
        w.record(&chain.prefix(7), 0).unwrap();
        let covered = if spends == 12 {
            8
        } else {
            w.record(&chain.prefix(13), 8).unwrap();
            14
        };
        let landed = w.claim_unbacked(&chain, covered).unwrap();
        eprintln!(
            "claim_unbacked of {spends} spends, {covered} vouched: {} CU, {} B",
            landed.units, landed.size
        );
        assert!(landed.size <= 4_096 && landed.units <= 200_000);
    }
}
